# Week 0 gate — Colosseum rules (checked 2026-09-19)

Source: https://colosseum.com/hackathon (canonical FAQ/rules page; `colosseum.org` 301-redirects here), FAQ item "Are Colosseum hackathons only for new products, and who is eligible to win?" — verified by rendering the live page in a browser and reading the FAQ answer's actual DOM text (a plain `curl`/WebFetch pass returns only an empty JS-SPA shell for this page, so the quote below was confirmed via `document.body.innerText` on the rendered page, not by trusting an automated summary).

Quote (verbatim, full FAQ answer under "Are Colosseum hackathons only for new products, and who is eligible to win?"):

> "Teams may begin development before the hackathon, but products are judged only on the work completed between the competition's start and end dates."
>
> "Builders may use pre-existing code, but teams must disclose all relevant past development work in the submission form."
>
> "If a team misrepresents its product's development history or fails to disclose relevant information, Colosseum retains the sole right to: Disqualify the team from the competition / Ban individual builders from participating in future Colosseum hackathons / Revoke prizes if applicable"
>
> "'Pre-existing code' does not refer to open-source code developed by others. We encourage founders to compose with existing crypto protocols."

Decision:
- [x] Product code (programs/, app/) MAY be committed before 28.09
- [ ] Product code MUST NOT be committed before 28.09 → Tasks 13–14 run locally on a branch `pre-hackathon` that is never pushed; spikes stay on main.

Rationale: the FAQ text above is Colosseum's general, evergreen policy (phrased "Colosseum hackathons", not scoped to one named event) and is unambiguous: pre-existing code is explicitly permitted. It is **not** an unconditional yes, though — two conditions apply and Tasks 13–14 must honor them:
1. **Disclosure is mandatory.** Any product code written before 28.09 must be disclosed as prior development work in the Colosseum submission form. Silent omission risks disqualification, a hackathon ban, or prize revocation per the quote above.
2. **Only work done inside the contest window is judged.** Pre-hackathon commits earn no competitive credit by themselves — judging looks at what changed between the contest's start and end dates. Practically: keep pre-28.09 product commits on `main`/history in a way that's easy to point to (so a "before" vs "during" diff is honest and disclosable), don't try to pass off spike-week work as hackathon-week work.

Caveat on which event this applies to (record for the controller, not a reason to flip the box): the page currently shows **"Crypto World's Fair"** (Sep 14 – Oct 12, 2026, multi-chain, prize tracks including a Solana track) as the *live* hackathon — not a hackathon starting 28.09 as assumed in this project's context. I read the official rules PDFs for both "Crypto World's Fair" (`https://colosseum.com/legal/Crypto%20World's%20Fair%20Hackathon%20Rules.pdf`, Contest Period Sep 14 – Oct 12, 2026) and "Solana Frontier Hackathon" (`https://colosseum.com/legal/Solana%20Frontier%20Hackathon%20Rules.pdf`, which turned out to be the **Spring** edition, Contest Period Apr 6 – May 11, 2026) in full — neither PDF contains a pre-existing-code clause itself; that clause lives only in the site FAQ quoted above. A Colosseum blog post ("Colosseum Codex: 2026 Hackathons", `https://blog.colosseum.com/2026-hackathons-updraft-course-offline-signer-cli/`) and an X post from Venture Launch both list Colosseum's second 2026 Solana hackathon window as **September 28 – November 2, 2026**, matching this project's assumption, but I could not find a dedicated rules page/PDF for that specific Sep 28 window distinct from "Crypto World's Fair" — it's unclear whether "Crypto World's Fair" (Sep 14 – Oct 12) replaced/absorbed that slot or whether a separate Sep 28 – Nov 2 Solana-only event will still be published later. Since the FAQ policy is worded generically for "Colosseum hackathons" and both rules PDFs I read are consistent with it (neither restricts pre-existing code further), the decision above should hold either way — but Tasks 13–14 should re-check `colosseum.com/hackathon` close to 28.09 to confirm which named event (and which rules PDF) Dexxer is actually entering.

Also checked: Solana Mobile CLOCK IN dates: **found** (this is the "third Solana Mobile hackathon", rendered via an interactive site at `https://solanamobile.radiant.nexus/`, "EVENT INFO → KEY DATES" panel, read directly from the rendered page):
- Submissions open: 8 Sep 2026
- Submissions due: 9 Oct 2026, 09:59 GMT+3
- Judging: 10 Oct 2026 – 9 Nov 2026
- Winners announced: ~10–11 Nov 2026 (page's KEY DATES panel says 11 Nov 2026; the page's plain-text RESULTS section separately says "Results announced November 10th" — the two disagree by a day, likely a timezone rounding artifact; treat "around Nov 10–11, 2026" as the answer)

CLOCK IN also has its own pre-existing-code rule, independently relevant to this gate: "Pre-existing projects are allowed if they show significant new mobile development during the hackathon. A pre-existing project with no new work is not eligible." — same shape as the Colosseum rule (prior code OK, but only new work during the window counts/qualifies).
