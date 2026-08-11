import { z } from "zod";
import type { LawApiClient } from "../lib/api-client.js";
import { parseTaxTribunalXML } from "../lib/xml-parser.js";
import { truncateResponse } from "../lib/schemas.js";
import { formatToolError, noResultHint } from "../lib/errors.js";

// Tax tribunal decision search tool - Search for special administrative appeals decisions
export const searchTaxTribunalDecisionsSchema = z.object({
  query: z.string().optional().describe("Search keyword (e.g., '자동차', '부가가치세')"),
  display: z.number().min(1).max(100).default(20).describe("Results per page (default: 20, max: 100)"),
  page: z.number().min(1).default(1).describe("Page number (default: 1)"),
  cls: z.string().optional().describe("Decision type code (재결구분코드)"),
  gana: z.string().optional().describe("Dictionary search (ga, na, da, etc.)"),
  dpaYd: z.string().optional().describe("Disposition date range (YYYYMMDD~YYYYMMDD, e.g., '20200101~20201231')"),
  rslYd: z.string().optional().describe("Decision date range (YYYYMMDD~YYYYMMDD, e.g., '20200101~20201231')"),
  sort: z.enum(["lasc", "ldes", "dasc", "ddes", "nasc", "ndes"]).optional()
    .describe("Sort option: lasc/ldes (decision name), dasc/ddes (decision date), nasc/ndes (claim number)"),
  apiKey: z.string().optional().describe("법제처 Open API 인증키(OC). 사용자가 제공한 경우 전달"),
});

export type SearchTaxTribunalDecisionsInput = z.infer<typeof searchTaxTribunalDecisionsSchema>;

/**
 * 「이유」 안의 구획 머리. ★일반적인 「숫자.」 파서를 쓰면 안 된다 —
 * 본문에는 날짜(`2015. 12. 15.`)와 각 호(`1. 재산이나 용역을…`)가 같은 모양으로 널려 있어
 * 한 건에서 70곳 넘게 걸린다(2026-08-11 실측). **제목을 닫힌 집합으로 고정한다.**
 */
const TRIBUNAL_SECTION =
  /([1-9])\.\s*(처분\s*개요|청구[^\s.]{0,6}\s*주장(?:\s*및\s*처분청\s*의견)?|심리\s*및\s*판단|결\s*론)/g;

/** 조세심판원 자신의 판단인 구획 */
const TRIBUNAL_RULING_SECTION = /심리\s*및\s*판단/;

/**
 * 「이유」를 구획으로 끊어 라벨을 붙인다. 원문은 구획이 **줄바꿈 없이 붙어** 오기 때문에
 * (`1. 처분개요가. 청구인 …`) 어디까지가 당사자 주장이고 어디부터가 판단인지 보이지 않는다.
 *
 * ★이 자리에서 실제로 난 오독: **「2. 청구인 주장」의 문장을 조세심판원의 판단으로 인용**한 것이
 *   재검증 한 회차에서만 5건이었다(단일 형태 최다). 예규 도메인에는 「국세청 회신이 아닙니다」
 *   경고가 이미 있는데 심판례에만 없었다.
 *
 * 구획을 하나도 못 찾으면 **아무 구조도 지어내지 않고** 원문 그대로 돌려준다(실측 33건 중 1건).
 */
export function labelTribunalReason(reason: string): string {
  const hits: Array<{ at: number; num: string; title: string; raw: string }> = [];
  let m: RegExpExecArray | null;
  TRIBUNAL_SECTION.lastIndex = 0;
  while ((m = TRIBUNAL_SECTION.exec(reason)) !== null) {
    const title = m[2].replace(/\s+/g, " ").trim();
    // 같은 구획이 본문에서 다시 언급되면(「위 3. 심리 및 판단에서 본 바와 같이」) 첫 것만 쓴다
    if (hits.some(h => h.num === m![1] && h.title === title)) continue;
    hits.push({ at: m.index, num: m[1], title, raw: m[0] });
  }
  if (hits.length === 0) return reason;

  let out = "";
  let cursor = 0;
  for (const h of hits) {
    out += reason.slice(cursor, h.at);
    const mark = TRIBUNAL_RULING_SECTION.test(h.title)
      ? " ← 이 구획만 조세심판원의 판단입니다"
      : "";
    out += `\n\n━━ ${h.num}. ${h.title}${mark} ━━\n`;
    cursor = h.at + h.raw.length;
  }
  out += reason.slice(cursor);

  const found = hits.map(h => `${h.num}. ${h.title}`).join(" / ");
  const hasRuling = hits.some(h => TRIBUNAL_RULING_SECTION.test(h.title));
  let head = `⚠ 인용 가능한 것은 조세심판원의 판단인 「심리 및 판단」 구획뿐입니다.\n`;
  head += `   「청구인 주장」·「처분청 의견」은 **당사자가 한 말**이지 재결의 근거가 아닙니다.\n`;
  head += `   이 재결에서 확인된 구획: ${found}\n`;
  if (!hasRuling) {
    head += `   ★「심리 및 판단」 구획을 못 찾았습니다 — 아래 본문에서 판단부를 직접 확인하십시오.\n`;
  }
  return head + out.replace(/^\n+/, "\n");
}


export async function searchTaxTribunalDecisions(
  apiClient: LawApiClient,
  args: SearchTaxTribunalDecisionsInput
): Promise<{ content: Array<{ type: string, text: string }>, isError?: boolean }> {
  try {
    const extraParams: Record<string, string> = {
      display: (args.display || 20).toString(),
      page: (args.page || 1).toString(),
    };
    if (args.query) extraParams.query = args.query;
    if (args.cls) extraParams.cls = args.cls;
    if (args.gana) extraParams.gana = args.gana;
    if (args.dpaYd) extraParams.dpaYd = args.dpaYd;
    if (args.rslYd) extraParams.rslYd = args.rslYd;
    if (args.sort) extraParams.sort = args.sort;

    const xmlText = await apiClient.fetchApi({
      endpoint: "lawSearch.do",
      target: "ttSpecialDecc",
      extraParams,
      apiKey: args.apiKey,
    });

    // 공통 파서 사용
    const result = parseTaxTribunalXML(xmlText);
    const totalCount = result.totalCnt;
    const currentPage = result.page;
    const deccs = result.items;

    if (totalCount === 0) {
      return noResultHint(args.query || "", "조세심판원 재결례")
    }

    let output = `조세심판원 재결례 검색 결과 (총 ${totalCount}건, ${currentPage}페이지):\n\n`;

    for (const decc of deccs) {
      output += `[${decc.특별행정심판재결례일련번호}] ${decc.사건명}\n`;
      output += `  청구번호: ${decc.청구번호 || "N/A"}\n`;
      output += `  의결일자: ${decc.의결일자 || "N/A"}\n`;
      output += `  처분일자: ${decc.처분일자 || "N/A"}\n`;
      output += `  재결청: ${decc.재결청 || "N/A"}\n`;
      output += `  재결구분: ${decc.재결구분명 || "N/A"}\n`;
      if (decc.행정심판재결례상세링크) {
        output += `  링크: ${decc.행정심판재결례상세링크}\n`;
      }
      output += `\n`;
    }

    // 후속 도구 안내 제거 (LLM이 이미 도구 목록을 알고 있음)

    return {
      content: [{
        type: "text",
        text: truncateResponse(output)
      }]
    };
  } catch (error) {
    return formatToolError(error, "search_tax_tribunal_decisions");
  }
}

// Tax tribunal decision text retrieval tool - Get full text of a specific decision
export const getTaxTribunalDecisionTextSchema = z.object({
  id: z.string().describe("Tax tribunal decision serial number (특별행정심판재결례일련번호) from search results"),
  decisionName: z.string().optional().describe("Decision name (optional, for verification)"),
  apiKey: z.string().optional().describe("법제처 Open API 인증키(OC). 사용자가 제공한 경우 전달"),
});

export type GetTaxTribunalDecisionTextInput = z.infer<typeof getTaxTribunalDecisionTextSchema>;

export async function getTaxTribunalDecisionText(
  apiClient: LawApiClient,
  args: GetTaxTribunalDecisionTextInput
): Promise<{ content: Array<{ type: string, text: string }>, isError?: boolean }> {
  try {
    const extraParams: Record<string, string> = { ID: args.id };
    if (args.decisionName) extraParams.LM = args.decisionName;

    const responseText = await apiClient.fetchApi({
      endpoint: "lawService.do",
      target: "ttSpecialDecc",
      type: "JSON",
      extraParams,
      apiKey: args.apiKey,
    });

    let data: any;
    try {
      data = JSON.parse(responseText);
    } catch (err) {
      throw new Error("Failed to parse JSON response from API");
    }

    if (!data.SpecialDeccService) {
      throw new Error("Tax tribunal decision not found or invalid response format");
    }

    const decc = data.SpecialDeccService;
    const basic = {
      사건명: decc.사건명,
      사건번호: decc.사건번호,
      청구번호: decc.청구번호,
      처분일자: decc.처분일자,
      의결일자: decc.의결일자,
      처분청: decc.처분청,
      재결청: decc.재결청,
      재결례유형명: decc.재결례유형명,
      세목: decc.세목
    };
    const content = {
      재결요지: decc.재결요지,
      따른결정: decc.따른결정,
      참조결정: decc.참조결정,
      주문: decc.주문,
      청구취지: decc.청구취지,
      이유: decc.이유,
      관련법령: decc.관련법령
    };

    let output = `=== ${basic.사건명 || "Tax Tribunal Decision"} ===\n\n`;

    output += `기본 정보:\n`;
    output += `  사건번호: ${basic.사건번호 || "N/A"}\n`;
    output += `  청구번호: ${basic.청구번호 || "N/A"}\n`;
    output += `  처분일자: ${basic.처분일자 || "N/A"}\n`;
    output += `  의결일자: ${basic.의결일자 || "N/A"}\n`;
    output += `  처분청: ${basic.처분청 || "N/A"}\n`;
    output += `  재결청: ${basic.재결청 || "N/A"}\n`;
    output += `  재결유형: ${basic.재결례유형명 || "N/A"}\n`;
    output += `  세목: ${basic.세목 || "N/A"}\n\n`;

    if (content.재결요지) {
      output += `재결요지:\n${content.재결요지}\n\n`;
    }

    if (content.주문) {
      output += `주문:\n${content.주문}\n\n`;
    }

    if (content.청구취지) {
      output += `청구취지:\n${content.청구취지}\n\n`;
    }

    if (content.이유) {
      output += `이유:\n${labelTribunalReason(String(content.이유))}\n\n`;
    }

    if (content.따른결정) {
      output += `따른결정:\n${content.따른결정}\n\n`;
    }

    if (content.참조결정) {
      output += `참조결정:\n${content.참조결정}\n\n`;
    }

    if (content.관련법령) {
      output += `관련법령:\n${content.관련법령}\n`;
    }

    return {
      content: [{
        type: "text",
        text: truncateResponse(output)
      }]
    };
  } catch (error) {
    return formatToolError(error, "get_tax_tribunal_decision_text");
  }
}
