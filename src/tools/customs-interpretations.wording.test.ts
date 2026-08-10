import { describe, it, expect } from "vitest";
import { readFileSync } from "node:fs";

// 문면 자체가 기능인 자리라 소스 텍스트로 대조한다(응답 조립에 외부 호출이 필요해 단위시험이 비싸다).
// ★2026-08-10 — 이 시험은 실제로 일어난 오독 둘에서 나왔다:
//   ⓐ 「인용하지 마세요」만 있으면 **「읽지 마세요」로 읽힌다.** 이 구획을 열지 않은 채 「원문에 사실관계가
//      없다」고 결론 낸 사례가 있었다(사실관계는 거기 있었다).
//   ⓑ 머리의 이유가 「회신이 아니다」뿐이라 **「3. 관련법령」의 조문은 공적 문언이니 써도 된다**로 갈라 읽혔고,
//      그 구획의 **구 법령 문언**이 근거로 인용된 사례가 있었다.
const SRC = readFileSync(new URL("./customs-interpretations.ts", import.meta.url), "utf8");

// ★재야 할 모집단은 파일 전체가 아니라 **응답으로 나가는 줄**뿐이다.
//   변이시험이 그것을 잡았다 — 파일 전체를 세면 아래 단언들이 **이 파일의 주석**에 걸려 통과한다.
const emitted = SRC.split("\n").filter((l) => l.includes("output +=")).join("\n");

describe("예규 본문(질의내용) 구획 머리 문면", () => {
  it("납세자 질의임을 밝히고 인용을 금지한다", () => {
    expect(emitted).toContain("국세청 회신이 아닙니다");
    expect(emitted).toMatch(/근거로 인용하지 마/);
  });

  it("★그러나 읽는 것은 요구한다 — 이 절반이 빠지면 「읽지 마세요」로 읽힌다", () => {
    expect(emitted).toMatch(/\*\*반드시 읽으십시오\*\*/);
  });

  it("왜 읽어야 하는지 = 상충/국면 판별이라는 것이 적혀 있다", () => {
    expect(emitted).toMatch(/어느 사실관계\(시점·거래구조\)에 대한 것인지/);
    expect(emitted).toMatch(/서로 어긋나는 것.*사안이 달라 둘 다 맞는 것/);
  });

  it("★「3. 관련법령」의 조문이 그 예규 시점 문언임을 따로 말한다", () => {
    expect(emitted).toMatch(/「3\. 관련법령」/);
    expect(emitted).toMatch(/그 예규 시점의 문언/);
    expect(emitted).toMatch(/법령 조회로 꺼낸 원문/);
  });
});
