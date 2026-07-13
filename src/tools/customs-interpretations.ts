import { z } from "zod";
import type { LawApiClient } from "../lib/api-client.js";
import { truncateResponse } from "../lib/schemas.js";
import { parseSearchXML, extractTag } from "../lib/xml-parser.js";
import { formatToolError, noResultHint } from "../lib/errors.js";
import { fetchTaxlawAction, extractTaxlawEditorBody, normalizeTaxlawBodyCandidate } from "./precedents.js";

// 관세청(kcsCgmExpc)·국세청(ntsCgmExpc) 응답 구조가 동일하므로 target만 분기해 재사용
type CgmExpcTarget = "kcsCgmExpc" | "ntsCgmExpc";
const TARGET_LABEL: Record<CgmExpcTarget, string> = {
  kcsCgmExpc: "관세청",
  ntsCgmExpc: "국세청",
};

/** 국세청 검색은 제목(section=itmNm)만 대상이라 관련 예규가 뒤로 밀린다 — 표시 하한을 올려 누락 방지 */
const NTS_MIN_DISPLAY = 50;

/** 국세청 문서ID(ntstDcmId) — 법제처 일련번호와 다른 체계. 본문 조회는 이 값으로만 가능 */
const NTST_DCM_ID_PATTERN = /^\d{15,20}$/;

/** 법령해석상세링크(taxlaw.nts.go.kr/...?ntstDcmId=...)에서 본문 조회용 문서ID를 뽑는다 */
function extractNtstDcmId(link: string | undefined): string {
  if (!link) return "";
  try {
    return new URL(link).searchParams.get("ntstDcmId") || "";
  } catch {
    return "";
  }
}

// Customs legal interpretation search tool - Search for customs law interpretations
export const searchCustomsInterpretationsSchema = z.object({
  query: z.string().optional().describe("Search keyword (e.g., '거래명세서', '세금')"),
  display: z.number().min(1).max(100).default(20).describe("Results per page (default: 20, max: 100)"),
  page: z.number().min(1).default(1).describe("Page number (default: 1)"),
  inq: z.number().optional().describe("Inquiry organization code (질의기관코드)"),
  rpl: z.number().optional().describe("Interpretation organization code (해석기관코드)"),
  gana: z.string().optional().describe("Dictionary search (ga, na, da, etc.)"),
  explYd: z.string().optional().describe("Interpretation date range (YYYYMMDD~YYYYMMDD, e.g., '20200101~20201231')"),
  sort: z.enum(["lasc", "ldes", "dasc", "ddes"]).optional()
    .describe("Sort option: lasc/ldes (interpretation name), dasc/ddes (interpretation date)"),
  apiKey: z.string().optional().describe("법제처 Open API 인증키(OC). 사용자가 제공한 경우 전달"),
});

export type SearchCustomsInterpretationsInput = z.infer<typeof searchCustomsInterpretationsSchema>;

export async function searchCustomsInterpretations(
  apiClient: LawApiClient,
  args: SearchCustomsInterpretationsInput
): Promise<{ content: Array<{ type: string, text: string }>, isError?: boolean }> {
  return searchCgmExpcByTarget(apiClient, args, "kcsCgmExpc");
}

/** 국세청 법령해석 검색 (#35) — 응답 구조 관세청과 동일, target만 분기. unified-decisions만 사용 */
export async function searchNtsInterpretations(
  apiClient: LawApiClient,
  args: SearchCustomsInterpretationsInput
): Promise<{ content: Array<{ type: string, text: string }>, isError?: boolean }> {
  return searchCgmExpcByTarget(apiClient, args, "ntsCgmExpc");
}

async function searchCgmExpcByTarget(
  apiClient: LawApiClient,
  args: SearchCustomsInterpretationsInput,
  target: CgmExpcTarget
): Promise<{ content: Array<{ type: string, text: string }>, isError?: boolean }> {
  const orgLabel = TARGET_LABEL[target];
  try {
    // 국세청은 제목검색뿐이라 상위 20건에 핵심 예규가 안 잡히는 사례가 많다 → 하한 상향
    const requested = args.display || 20;
    const display = target === "ntsCgmExpc" ? Math.max(requested, NTS_MIN_DISPLAY) : requested;
    const extraParams: Record<string, string> = {
      display: display.toString(),
      page: (args.page || 1).toString(),
    };
    if (args.query) extraParams.query = args.query;
    if (args.inq !== undefined) extraParams.inq = args.inq.toString();
    if (args.rpl !== undefined) extraParams.rpl = args.rpl.toString();
    if (args.gana) extraParams.gana = args.gana;
    if (args.explYd) extraParams.explYd = args.explYd;
    if (args.sort) extraParams.sort = args.sort;

    const xmlText = await apiClient.fetchApi({
      endpoint: "lawSearch.do",
      target,
      extraParams,
      apiKey: args.apiKey,
    });

    // parseSearchXML 사용 (rootTag: CgmExpc, itemTag: cgmExpc)
    const { totalCnt, page: currentPage, items: expcs } = parseSearchXML(
      xmlText, "CgmExpc", "cgmExpc",
      (content) => ({
        법령해석일련번호: extractTag(content, "법령해석일련번호"),
        안건명: extractTag(content, "안건명"),
        안건번호: extractTag(content, "안건번호"),
        질의기관코드: extractTag(content, "질의기관코드"),
        질의기관명: extractTag(content, "질의기관명"),
        해석기관코드: extractTag(content, "해석기관코드"),
        해석기관명: extractTag(content, "해석기관명"),
        해석일자: extractTag(content, "해석일자"),
        법령해석상세링크: extractTag(content, "법령해석상세링크"),
      })
    );

    const totalCount = totalCnt;

    if (totalCount === 0) {
      return noResultHint(args.query || "", `${orgLabel} 법령해석`)
    }

    let output = `${orgLabel} 법령해석 검색 결과 (총 ${totalCount}건, ${currentPage}페이지):\n\n`;

    for (const expc of expcs) {
      output += `[${expc.법령해석일련번호}] ${expc.안건명}\n`;
      if (expc.안건번호) {
        output += `  문서번호: ${expc.안건번호}\n`;
      }
      output += `  질의기관: ${expc.질의기관명 || "N/A"}\n`;
      output += `  해석기관: ${expc.해석기관명 || "N/A"}\n`;
      output += `  해석일자: ${expc.해석일자 || "N/A"}\n`;
      if (expc.법령해석상세링크) {
        output += `  링크: ${expc.법령해석상세링크}\n`;
        const ntstDcmId = target === "ntsCgmExpc" ? extractNtstDcmId(expc.법령해석상세링크) : "";
        if (ntstDcmId) {
          output += `  ntstDcmId: ${ntstDcmId}  ← 본문: get_decision_text(domain="nts", id="${ntstDcmId}")\n`;
        }
      }
      output += `\n`;
    }

    if (target === "ntsCgmExpc" && totalCount > expcs.length) {
      output += `⚠️ 총 ${totalCount}건 중 ${expcs.length}건만 표시. 국세청 검색은 **제목만** 대상이고 관련도순이 아니라, 핵심 예규가 뒤에 묻힐 수 있습니다.\n`;
      output += `   빠짐 없이 보려면 display를 올리거나(최대 100) page를 넘기세요. 제목에 없는 말로는 검색되지 않으니 문서번호·다른 표현으로도 검색하세요.\n`;
    }

    return {
      content: [{
        type: "text",
        text: truncateResponse(output)
      }]
    };
  } catch (error) {
    return formatToolError(error, target === "ntsCgmExpc" ? "search_nts_interpretations" : "search_customs_interpretations");
  }
}

// Customs legal interpretation text retrieval tool - Get full text of a specific interpretation
export const getCustomsInterpretationTextSchema = z.object({
  id: z.string().describe("Customs interpretation serial number (법령해석일련번호) from search results"),
  interpretationName: z.string().optional().describe("Interpretation name (optional, for verification)"),
  apiKey: z.string().optional().describe("법제처 Open API 인증키(OC). 사용자가 제공한 경우 전달"),
});

export type GetCustomsInterpretationTextInput = z.infer<typeof getCustomsInterpretationTextSchema>;

export async function getCustomsInterpretationText(
  apiClient: LawApiClient,
  args: GetCustomsInterpretationTextInput
): Promise<{ content: Array<{ type: string, text: string }>, isError?: boolean }> {
  return getCgmExpcTextByTarget(apiClient, args, "kcsCgmExpc");
}

/**
 * 국세청 법령해석 본문 조회 (#35)
 *
 * 법제처 OPEN API는 국세청 법령해석에 **목록 조회만 제공**한다(`lawService.do?target=ntsCgmExpc` 없음).
 * 대신 검색 응답의 `법령해석상세링크`에 담긴 국세청 문서ID(`ntstDcmId`)로
 * 국세청 조회 endpoint에 직접 질의해 본문을 가져온다(판례 HTML 폴백과 동일 경로 재사용).
 *
 * ⚠️ 국세청 문서는 두 본문이 성격이 정반대다 — 섞으면 안 된다:
 *   - `dcmDVO.ntstDcmCntn`      = **국세청 회신**(답변).           ← 핵심
 *   - `dcmHwpEditorDVOList`     = **납세자 질의서**(`qstn/...`).   ← 참고
 * 판례용 `extractTaxlawBody()`는 에디터를 우선하므로 여기서 쓰면 회신이 통째로 유실된다.
 */
export async function getNtsInterpretationText(
  _apiClient: LawApiClient,
  args: GetCustomsInterpretationTextInput
): Promise<{ content: Array<{ type: string, text: string }>, isError?: boolean }> {
  // 법제처 일련번호(짧은 숫자)로는 국세청 본문을 찾을 수 없다 — 변환식도 없다
  if (!NTST_DCM_ID_PATTERN.test(args.id)) {
    const text =
      `[NEED_NTST_DCM_ID] 국세청 법령해석 본문은 국세청 문서ID(ntstDcmId)로 조회합니다.\n\n` +
      `받은 id: ${args.id} — 법제처 일련번호로 보이며, 본문 조회에는 쓸 수 없습니다(두 번호 사이에 변환식이 없습니다).\n` +
      `search_decisions(domain="nts") 결과의 'ntstDcmId' 값을 id로 넣어 다시 호출하세요.\n` +
      `예: get_decision_text(domain="nts", id="010000000000050559")`;
    return { content: [{ type: "text", text }] };
  }

  try {
    const referer = `https://taxlaw.nts.go.kr/qt/USEQTA002P.do?ntstDcmId=${args.id}`;
    const actionData = (await fetchTaxlawAction(args.id, referer))?.data?.ASIQTB002PR01;
    const dcm = actionData?.dcmDVO;

    // 국세청은 존재하지 않는 id에도 status=SUCCESS + dcmDVO=null 을 준다.
    // 이걸 "본문 없음"으로 흘리면 LLM이 '예규 부존재'로 오독한다 — 반드시 구분한다.
    if (!dcm) {
      const text =
        `[LOOKUP_FAILED] ntstDcmId ${args.id} 로 문서를 찾지 못했습니다(국세청 응답이 비어 있음).\n\n` +
        `id가 틀렸거나 국세청 조회 방식이 바뀐 경우입니다.\n` +
        `⚠️ 이것은 해당 예규의 **부존재를 의미하지 않습니다**. 본문을 추측하지 말고 search_decisions(domain="nts")로 다시 확인하세요.\n` +
        `원문 링크: ${referer}`;
      return { content: [{ type: "text", text }], isError: true };
    }

    const reply = normalizeTaxlawBodyCandidate(dcm.ntstDcmCntn);   // 국세청 회신
    const question = extractTaxlawEditorBody(actionData);          // 납세자 질의서

    let output = `=== ${dcm.ntstDcmTtl || "국세청 법령해석"} ===\n\n`;
    output += `기본 정보:\n`;
    output += `  문서번호: ${dcm.ntstDcmDscmCntn || "N/A"}\n`;
    output += `  귀속연도: ${dcm.attrYr || "N/A"}\n`;
    output += `  ntstDcmId: ${args.id}\n\n`;

    if (dcm.ntstDcmGistCntn) {
      output += `요지:\n${dcm.ntstDcmGistCntn}\n\n`;
    }

    if (reply) {
      output += `회신:\n${reply}\n\n`;
    }

    if (question) {
      output += `본문:\n`;
      output += `※ 아래는 납세자가 제출한 질의내용 요약·관련법령이며, **국세청 회신이 아닙니다**. 근거로 인용하지 마세요.\n`;
      output += `${question}\n\n`;
    }

    if (!reply && !question) {
      output += `⚠️ 회신 본문이 비어 있습니다(회신생략 문서일 수 있음). 해당 예규가 존재하지 않는다는 뜻은 아닙니다 — 요지·링크로 판단하세요.\n\n`;
    }

    output += `원문 링크: ${referer}\n`;

    return {
      content: [{
        type: "text",
        text: truncateResponse(output)
      }]
    };
  } catch (error) {
    return formatToolError(error, "get_nts_interpretation_text");
  }
}

async function getCgmExpcTextByTarget(
  apiClient: LawApiClient,
  args: GetCustomsInterpretationTextInput,
  target: CgmExpcTarget
): Promise<{ content: Array<{ type: string, text: string }>, isError?: boolean }> {
  try {
    const extraParams: Record<string, string> = { ID: args.id };
    if (args.interpretationName) extraParams.LM = args.interpretationName;

    const responseText = await apiClient.fetchApi({
      endpoint: "lawService.do",
      target,
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

    if (!data.CgmExpcService) {
      throw new Error("Customs interpretation not found or invalid response format");
    }

    const expc = data.CgmExpcService;
    const basic = {
      안건명: expc.안건명,
      법령해석일련번호: expc.법령해석일련번호,
      업무분야: expc.업무분야,
      해석일자: expc.해석일자,
      해석기관명: expc.해석기관명,
      질의기관명: expc.질의기관명,
      등록일시: expc.등록일시
    };
    const content = {
      질의요지: expc.질의요지,
      회답: expc.회답,
      이유: expc.이유,
      관련법령: expc.관련법령,
      관세법령정보포털원문링크: expc.관세법령정보포털원문링크
    };

    let output = `=== ${basic.안건명 || "Customs Interpretation"} ===\n\n`;

    output += `기본 정보:\n`;
    output += `  해석일련번호: ${basic.법령해석일련번호 || "N/A"}\n`;
    output += `  업무분야: ${basic.업무분야 || "N/A"}\n`;
    output += `  해석일자: ${basic.해석일자 || "N/A"}\n`;
    output += `  질의기관: ${basic.질의기관명 || "N/A"}\n`;
    output += `  해석기관: ${basic.해석기관명 || "N/A"}\n`;
    output += `  등록일시: ${basic.등록일시 || "N/A"}\n\n`;

    if (content.질의요지) {
      output += `질의요지:\n${content.질의요지}\n\n`;
    }

    if (content.회답) {
      output += `회답:\n${content.회답}\n\n`;
    }

    if (content.이유) {
      output += `이유:\n${content.이유}\n\n`;
    }

    if (content.관련법령) {
      output += `관련법령:\n${content.관련법령}\n\n`;
    }

    if (content.관세법령정보포털원문링크) {
      output += `원문 링크: ${content.관세법령정보포털원문링크}\n`;
    }

    return {
      content: [{
        type: "text",
        text: truncateResponse(output)
      }]
    };
  } catch (error) {
    return formatToolError(error, target === "ntsCgmExpc" ? "get_nts_interpretation_text" : "get_customs_interpretation_text");
  }
}

