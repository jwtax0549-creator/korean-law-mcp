import { describe, it, expect } from "vitest"
import { noResultHint } from "./errors.js"

// 2026-08-06 실측 — 제안이 「앞에서부터 자르기」라 정답이 뒤쪽 낱말이면 구조적으로 못 준다.
//   국세청 레인: 「특정법인 초과배당」 0건 → 제안된 「특정법인」 161건에 정답 없음,
//   제안되지 않은 「초과배당」 41건에 정답(서면-2017-법령해석재산-1495) 있음.
// 그래서 낱말을 자르지 않고 각각 제안한다. ★어떤 형태의 절단도 같은 결함을 되살린다.
const text = (r: { content: Array<{ text: string }> }) => r.content[0]?.text ?? ""

describe("noResultHint 재시도 제안", () => {
  it("각 낱말을 따로 제안한다 — 앞에서 자르지 않는다", () => {
    const t = text(noResultHint("특정법인 초과배당"))
    expect(t).toContain('"초과배당"')
    expect(t).toContain('"특정법인"')
  })

  it("마지막 낱말도 제안한다(긴 자연어 질의가 실제 실패 형태였다)", () => {
    const t = text(noResultHint("무단점유 토지 명도 양성화 컨설팅 용역비"))
    expect(t).toContain('"용역비"')
    expect(t).toContain('"무단점유"')
  })

  it("한 낱말이면 제안하지 않는다 (양성 대조 — 하네스가 함수에 닿는지)", () => {
    expect(text(noResultHint("초과배당"))).toContain("다른 키워드로 재시도하세요.")
  })
})
