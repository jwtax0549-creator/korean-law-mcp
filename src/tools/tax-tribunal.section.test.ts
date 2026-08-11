import { describe, it, expect } from "vitest";
import { labelTribunalReason } from "./tax-tribunal-decisions.js";

// 문면은 조세심판원 재결례 실물 모양 그대로다(2026-08-11 · 재결 60건 실측).
// ★원문은 구획이 **줄바꿈 없이 붙어** 온다 — `1. 처분개요가. 청구인은 …`
//   그래서 어디까지가 당사자 주장이고 어디부터가 판단인지 보이지 않는다.

/** 실물의 소음: 날짜(`2015. 12. 15.`)와 각 호(`1. 재산이나 용역을…`)가 구획 머리와 같은 모양이다.
 *  일반 「숫자.」 파서를 쓰면 한 건에서 70곳 넘게 걸린다 — 그래서 제목을 닫힌 집합으로 고정한다. */
const FULL = `1. 처분개요가. 청구인은 2015. 12. 15. 법률 제13557호로 개정된 규정에 따라 신고하였다.나. 처분청은 2020. 3. 2. 증여세를 결정·고지하였다.2. 청구인 주장 및 처분청 의견가. 청구인 주장쟁점규정은 개정 전 규정이 적용되어야 한다.나. 처분청 의견청구주장은 이유 없다.3. 심리 및 판단가. 이 건의 쟁점은 다음과 같다. 특정법인과의 거래 유형은 1. 재산이나 용역을 무상으로 제공하는 거래 2. 재산이나 용역을 통상적인 거래 관행에 비추어 현저히 낮은 대가로 양도하는 거래이다.나. 살피건대 청구주장은 받아들이기 어렵다.4. 결론이 건 심판청구는 심리결과 청구주장이 이유 없으므로 기각한다.`;

/** 라벨을 걷어내 원문을 복원한다 — 라벨 삽입이 본문 글자를 먹었는지 재는 유일한 방법 */
const restore = (out: string) =>
  out
    .replace(/^⚠[^]*?이 재결에서 확인된 구획: [^\n]*\n(?:   ★[^\n]*\n)?/, "")
    .replace(/\n+━━ (\d)\. ([^━]*?)(?: ← 이 구획만 조세심판원의 판단입니다)? ━━\n/g, "$1. $2");

describe("labelTribunalReason — 심판례 이유 구획 라벨", () => {
  it("네 구획을 찾아 라벨을 붙이고 판단부를 표시한다", () => {
    const out = labelTribunalReason(FULL);
    const marks = [...out.matchAll(/━━ (\d\. [^━]+?)(?: ← [^━]*)? ━━/g)].map(m => m[1].trim());
    expect(marks).toEqual(["1. 처분개요", "2. 청구인 주장 및 처분청 의견", "3. 심리 및 판단", "4. 결론"]);
    expect(out).toContain("3. 심리 및 판단 ← 이 구획만 조세심판원의 판단입니다");
  });

  it("★날짜와 각 호는 구획이 아니다", () => {
    const out = labelTribunalReason(FULL);
    expect(out).not.toContain("━━ 1. 재산이나");
    expect(out).not.toContain("━━ 2. 재산이나");
    expect(out).not.toContain("━━ 1. 처분개요가");   // 다음 글자를 먹으면 안 된다
    expect(out.match(/━━ \d\./g)).toHaveLength(4);
  });

  it("★본문을 한 글자도 먹지 않는다", () => {
    expect(restore(labelTribunalReason(FULL)).replace(/\s/g, "")).toBe(FULL.replace(/\s/g, ""));
  });

  it("당사자 주장은 근거가 아니라는 경고가 머리에 붙는다", () => {
    const out = labelTribunalReason(FULL);
    expect(out).toMatch(/인용 가능한 것은 조세심판원의 판단인 「심리 및 판단」 구획뿐/);
    expect(out).toMatch(/당사자가 한 말/);
  });

  it("★구획을 하나도 못 찾으면 구조를 지어내지 않는다(원문 그대로)", () => {
    const plain = "청구인은 2020. 3. 2. 증여세를 신고하였고 처분청은 이를 경정하였다.";
    expect(labelTribunalReason(plain)).toBe(plain);
  });

  it("★「심리 및 판단」이 없으면 그 사실을 말한다(실측 53건 중 1건)", () => {
    const noRuling = "1. 처분개요청구인은 신고하였다.2. 청구인 주장 및 처분청 의견청구주장은 다음과 같다.";
    const out = labelTribunalReason(noRuling);
    expect(out).toContain("★「심리 및 판단」 구획을 못 찾았습니다");
    expect(out).not.toContain("← 이 구획만 조세심판원의 판단입니다");
  });

  it("같은 구획이 본문에서 다시 언급돼도 라벨은 하나다", () => {
    const again = FULL + "앞의 3. 심리 및 판단에서 본 바와 같이 청구주장은 이유 없다.";
    expect(labelTribunalReason(again).match(/━━ 3\. 심리 및 판단/g)).toHaveLength(1);
  });

  it("빈 이유에 안 터진다", () => {
    expect(labelTribunalReason("")).toBe("");
  });
});
