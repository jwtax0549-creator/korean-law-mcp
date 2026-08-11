import { describe, it, expect } from "vitest";
import { buildAddendaIndex } from "./law-text.js";

// 부칙 문면은 전부 법제처 실물에서 그대로 옮겼다(상증법 시행령 MST 283637 · 소득세법 MST 267581 · 2026-08-11).
const flat = (x: any): string[] => (Array.isArray(x) ? x : [x]).map(String);
const bu = (일자: string, 번호: string, ...lines: string[]) =>
  ({ 부칙공포일자: 일자, 부칙공포번호: 번호, 부칙내용: lines });

// 이 법령에 실재하는 조문(양성 대조 겸 모법·타법 조문 차단기)
const KNOWN = new Set(["제2조의2", "제12조", "제16조", "제26조", "제34조의5"]);

describe("buildAddendaIndex — 이 조문을 건드리는 부칙", () => {
  it("「개정규정」 줄에서 조문을 뽑고 부칙 조 제목까지 남긴다", () => {
    const idx = buildAddendaIndex([bu("20260227", "36131",
      "제1조(시행일) 이 영은 공포한 날부터 시행한다.",
      "제2조(특수관계인의 범위에 관한 적용례) 제2조의2제1항제3호가목의 개정규정은 이 영 시행 이후 결정 또는 경정하는 경우부터 적용한다.",
    )], flat, KNOWN);
    expect(idx["제2조의2"]).toEqual(["20260227 제36131호 제2조(특수관계인의 범위에 관한 적용례)"]);
    expect(idx["제1조"]).toBeUndefined();   // 부칙 자기 머리는 참조가 아니다
  });

  it("★옛 부칙은 「개정」을 안 쓴다 — 조 제목의 「적용례」로 잡는다", () => {
    // 실측: 「개정규정」만 보면 조문을 든 줄의 20~27%가 샜고 그 안에 진짜가 있었다
    const idx = buildAddendaIndex([bu("19941222", "04803",
      "제4조 (직장공제회 초과반환금에 관한 적용례) 제16조제1항제11호의 규정은 1999년 1월 1일이후 최초로 직장공제회에 가입하여 불입하는 것부터 적용한다.",
    )], flat, KNOWN);
    expect(idx["제16조"]).toEqual(["19941222 제04803호 제4조 (직장공제회 초과반환금에 관한 적용례)"]);
  });

  it("★다른 법령의 조문(「법인세법 시행령」 제39조)은 이 법령의 것이 아니다", () => {
    const idx = buildAddendaIndex([bu("20260227", "36131",
      "제4조(공익법인등의 범위에 관한 적용례 등) ① 제12조 각 호 외의 부분 단서의 개정규정은 이 영 시행 이후 「법인세법 시행령」 제39조제1항제1호바목에 따른 공익법인등으로 고시되는 경우부터 적용한다.",
    )], flat, KNOWN);
    expect(Object.keys(idx)).toEqual(["제12조"]);
  });

  it("★모법 조문번호는 이 법령에 없으므로 버린다(known 대조)", () => {
    const lines = ["제3조(특정법인과의 거래에 관한 적용례) 제45조의5제1항의 개정규정은 이 영 시행 이후 거래하는 경우부터 적용한다."];
    expect(Object.keys(buildAddendaIndex([bu("20250228", "35351", ...lines)], flat, KNOWN))).toEqual([]);
    // ★known을 안 주면 걸러지지 않는다 — 이 시험이 그 차단기가 실제로 도는지를 잰다
    expect(Object.keys(buildAddendaIndex([bu("20250228", "35351", ...lines)], flat))).toEqual(["제45조의5"]);
  });

  it("★「다른 법령의 개정」은 자구정비라 적용시기를 바꾸지 않는다", () => {
    const idx = buildAddendaIndex([bu("20251230", "35947",
      "제6조(다른 법령의 개정) 제16조제1항의 개정규정 중 \"재정경제부\"를 \"기획재정부\"로 한다.",
    )], flat, KNOWN);
    expect(idx["제16조"]).toBeUndefined();
  });

  it("시행일 조항만 있는 부칙은 아무것도 안 만든다", () => {
    const idx = buildAddendaIndex([bu("20251001", "35811",
      "이 영은 공포한 날부터 시행한다.",
    )], flat, KNOWN);
    expect(idx).toEqual({});
  });

  it("같은 조문을 여러 부칙이 건드리면 전건 쌓는다", () => {
    const idx = buildAddendaIndex([
      bu("20140221", "25195", "제5조(영농상속공제를 받은 상속재산의 사후관리에 관한 적용례) 제16조제10항의 개정규정은 이 영 시행 이후 상속이 개시되는 경우부터 적용한다."),
      bu("20230228", "33278", "제11조(영농상속공제 요건에 관한 경과조치) 이 영 시행 전에 상속이 개시된 경우에는 제16조제4항의 개정규정에도 불구하고 종전의 규정에 따른다."),
    ], flat, KNOWN);
    expect(idx["제16조"]).toHaveLength(2);
  });

  it("빈 부칙에 안 터진다", () => {
    expect(buildAddendaIndex([], flat, KNOWN)).toEqual({});
  });
});
