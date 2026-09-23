# Approved ASCENSION design release

Approved concepts: design-concepts/UX-SPEC.md in the coordination workspace. Visual direction: limestone #F4F2EB, paper #FCFBF7, ink #17232D, cobalt #2454D8, lime #DFFF83, clay #B85836. DOM controls remain functional; no mockup screens used as interface.

## Routes and existing contracts
| Screen | Route | Existing module/API | Ownership/limitations |
| --- | --- | --- | --- |
| Overview | / | GET dataset, baseline, health via brand-ui.js | Real server metrics, retry on error; configured AI is not a successful request claim |
| Manual scenarios/results | /classic.html | app.js validate/simulate/explain, scenario library, comparison, alternatives, brief | Existing state guards/reset retained; core untouched |
| 3D map, AI planner, quarterly trajectory | /command-center.html | command-center.js + bridge; /api/plan, /api/trajectory | Existing shell/lifecycle unchanged apart from brand and navigation markup |
| Citizen submission/tracking | /citizens.html | citizen.js, citizen config/complaints/photo/receipt | Existing privacy/consent/form constraints retained |
| Akim queue | /mayor.html | mayor.js auth/complaints/photo/update | Existing IDs, optimistic version conflicts and authorization retained |
| Tasks | /classic.html#action-register-details | action-register, team-workspace | Workspace backend arrives through Git owner's newer main integration |
| Data/method | /classic.html#city and #evidence-register-details and #method | existing data and evidence modules | Same synthetic model and provenance |

Homepage intentionally changes from command center to approved editorial overview. The fully working command center remains on its explicit route. Alisher's comparison/chat/backend are not replaced. Original comparison files untouched.

## Validation
- Base c912735269ecc7bf2d763a1594d540ae6df75a0f. 538 tests pass, zero fail, one optional native workspace skip; no tests weakened.
- Quality: 121 authored JS, 191 relative static imports, five shared security headers. Policy-worker matches its source. CSS parsed by esbuild.
- Browser on real Node server 127.0.0.1:3102: overview 5/100/52.56 with five district metrics; navigate to classic, load official example, calculate 95/5 budget and Score56.54, mean58.08, critical0; honest local no-key explanation fallback.
- Browser: command center loads actual 3D map, demo plan opens existing drawer, simulate completes and trajectory Q8 renders56.54. Drawer fixed to one scroll column to keep calculation accessible. Original hidden header removed from tab order during shell mount.
- Browser: actual390x844 screenshots on overview, classic, command center, citizen and mayor routes; document width does not exceed viewport. Native form/select interactions and async state preserved. Desktop overview/classic/command screenshots inspected.
- Citizen/mayor: all63 original IDs, required/limits/name/type/form actions unchanged; four capability tests pass. No citizen records were submitted or modified by this redesign.
- Two independent read-only audits: local links/assets/hash targets/ARIA references valid. Focus clipping in queue fixed with inset focus outline.

## Delivery scope
Modified public files: index.html, classic.html, command-center.html, command-center.js, citizens.html, mayor.html.
New public files: brand.css, home-design.css, simulator-design.css, widgets-design.css, command-design.css, portal-design.css, brand-ui.js, assets/design/ascension-mark.svg, assets/design/city-hero-approved.png.
New docs: design-validation.md, approved-design-release.md, design-image-prompt.txt.
No backend, core, data, auth, Telegram, Wrangler, secret or comparison source changes. Final integrated commit, Worker dry-run and publication owned by Git/hosting tasks.

## AI and publication
User chose existing hosted server AI configuration. One earlier authorized synthetic live explanation returned HTTP200, mode ai, available true and canonical56.54. No key changes. Local testing has no secret and honestly shows deterministic fallback. Live planner and final deployment must be verified against the final integrated version; do not infer deployment from a pushed commit or old checks. Migration of historical receipts remains separate and is not claimed by this visual release.
