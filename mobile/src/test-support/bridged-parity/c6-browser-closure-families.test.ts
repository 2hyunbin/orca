import { describe, expect, it } from 'vitest'
import { C1_PAGE_CLOSURE } from './c1-page-closure'
import { C2_PAGE_CLOSURE } from './c2-page-closure'
import { C3_PAGE_CLOSURE } from './c3-page-closure'
import { C5_PAGE_CLOSURE } from './c5-page-closure'
import { C6_BROWSER_CLOSURE_FAMILIES } from './c6-browser-closure-families'
import { pageClosureTotals } from './page-closure'

describe('the C6 browser closure half', () => {
  it('is the census the design named: 4 families, 15 goldens', () => {
    const goldens = Object.values(C6_BROWSER_CLOSURE_FAMILIES).flatMap((family) =>
      Object.keys(family)
    )
    expect({
      families: Object.keys(C6_BROWSER_CLOSURE_FAMILIES).length,
      goldens: goldens.length
    }).toEqual({ families: 4, goldens: 15 })
    expect(new Set(goldens).size).toBe(goldens.length)
  })

  // Totals catch a table that is internally consistent but derived incorrectly.
  it('pins six byte-identical goldens and nine in one named class', () => {
    expect(pageClosureTotals(C6_BROWSER_CLOSURE_FAMILIES)).toEqual({
      identical: 6,
      'result-absent-settlement': 9
    })
  })

  // Each added family must include byte-identical evidence, beyond merely naming its divergence.
  it('leaves no family excluded whole', () => {
    for (const [family, goldens] of Object.entries(C6_BROWSER_CLOSURE_FAMILIES)) {
      expect({ family, identical: Object.values(goldens).includes('identical') }).toEqual({
        family,
        identical: true
      })
    }
  })

  it('agrees with the C2 classification rule on every golden', () => {
    for (const goldens of Object.values(C6_BROWSER_CLOSURE_FAMILIES)) {
      for (const [id, verdict] of Object.entries(goldens)) {
        expect({ id, verdict }).toEqual({
          id,
          verdict: id.startsWith('matrix-') ? 'result-absent-settlement' : 'identical'
        })
      }
    }
  })

  // These pane-only families do not overlap inherited tables; session tab creation belongs to C7.
  it('shares no family with C1, C2, C3 or C5', () => {
    const others = new Set([
      ...Object.keys(C1_PAGE_CLOSURE),
      ...Object.keys(C2_PAGE_CLOSURE),
      ...Object.keys(C3_PAGE_CLOSURE),
      ...Object.keys(C5_PAGE_CLOSURE)
    ])
    expect(Object.keys(C6_BROWSER_CLOSURE_FAMILIES).filter((family) => others.has(family))).toEqual(
      []
    )
  })
})
