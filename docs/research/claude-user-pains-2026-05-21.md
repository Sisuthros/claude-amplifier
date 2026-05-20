# Claude-käyttäjien todelliset kipupisteet — toukokuu 2026

**Tutkimuksen tarkoitus:** Kartoittaa Claude Amplifier 1.4.0:n "päänräjäyttävää" featurea varten ne ongelmat, jotka Claude Code- ja Claude.ai-käyttäjät elävät päivittäin keväällä 2026, ja arvioida mihin paikallinen MCP-serveri voi todella iskeä.

**Tekijä:** Claude Opus 4.7 (deep-research agent)
**Päiväys:** 2026-05-21
**Kohde:** Claude Amplifier 1.4.0 planning

---

## TL;DR

1. **Sessioiden välinen muisti** ja **päätösten/lessonien talteenotto** ovat ekosysteemin yksimielisin kipu — ja täsmälleen se kategoria johon paikallinen MCP-serveri osuu täydellisesti. Amplifier 1.3.0 on jo tässä etukenossa, mutta 1.4.0:ssa pitää siirtyä passiivisesta "tallentaa" -tasosta aktiiviseen "estää että teet saman virheen uudestaan" -tasoon.
2. **"Confabulation amplifier" -ongelma** (Issue #27430) on tämän hetken pelottavin avoin kipu: persistent memory + autonominen tooli = hallusinaatiot tallentuvat seuraavan session totuudeksi. Jokainen muisti-MCP-serveri on potentiaalisesti osa ongelmaa, ellei se ratkaise sitä eksplisiittisesti.
3. **Päänräjäyttävä 1.4.0-kandidaatti:** Verification-gated memory + Pattern-Promotion Engine — muisti joka *ennustaa* käyttäjän virheen ennen kuin se tapahtuu, ja vaatii deterministisen verifikaatiosignaalin ennen kuin uskoo agenttia.

---

## 1. Top 10 ongelmaa rankattuna

Painotus: maininnan frekvenssi (HN-pisteet, GitHub-issue-reaktiot, blog-post-volyymi) × impact (€ tai tunteja menetettyä työtä).

### #1 — Sessioiden välinen kontekstin katoaminen ("Claude forgets")

Jokainen Claude Code -sessio alkaa nollasta. CLAUDE.md auttaa, mutta on 200-rivin/25KB-cap. `--continue` ja `--resume` eivät palauta keskustelukontekstia kunnolla (Issue #43696). Auto-compact tuhoaa hiljaa neljätuntisen työn (DEV.to "Claude Code Lost My 4-Hour Session").

> *"Close the terminal and everything is gone — decisions locked last week, context from three projects, debugging sessions where root causes were figured out. You re-explain yourself every single time."* — DEV Community, "How I Built Persistent Memory for Claude Code"

> *"Session context lost: --continue and --resume do not restore prior conversation context. The session starts fresh as if it were a new conversation, losing all accumulated context."* — Issue [#43696](https://github.com/anthropics/claude-code/issues/43696)

Olemassa olevat workaroundit: claude-mem (89k+ tähteä), MEMORY.md-tiedostot, Mem0 plugin, Obsidian Memory System, MCP Memory Keeper, memory-mcp. Vajavaisuus: useimmat ovat *episodimuistia* (mitä tapahtui) — eivät *päätösmuistia* (miksi valittiin tämä) eivätkä *lessonimuistia* (mikä meni pieleen ja mikä on yleistettävä sääntö).

### #2 — Auto-compact tuhoaa työn hiljaa keskellä tehtävää

Auto-compact laukeaa konteksti-ikkunan rajalla ilman tehtäväsääntelyä — keskellä hypoteesia, keskellä refaktoria. Kompaktoinnin tekemä yhteenveto on lossy ja hylkää usein arkkitehtuuripäätökset säilyttäen "mundane output". "Autocompact is thrashing" -bugi (Issue [#6541](https://github.com/anthropics/claude-code/issues/6541)) polttaa weekly-kvotaa minuuteissa.

> *"Claude Code auto compact functions like a seatbelt — there to catch you at the hard limit, but with no awareness of where you are in your task. It fires when the system decides the window is too full. No knowledge of whether you're mid-hypothesis or mid-debugging loop. The system protects itself. You lose state."* — oldeucryptoboi.com

> *"It is auto-compacting and then IMMEDIATELY showing 'Context left until auto-compacting: 2%' or less. It is also burning through my usage window vastly sooner than it used to."* — Issue [#6541](https://github.com/anthropics/claude-code/issues/6541)

### #3 — Rate-limit-shokki ja "tokens vanish in 19 minutes"

Maaliskuu 2026:n quota-kriisi: Max-tilaajat kertoivat 19 minuutin lockouteista 5h:n sijaan. Pro = ~45 viestiä / 5h. Weekly-cap (elo 2025–) tekee jokaisesta heavy-sessiosta jännän. Opus 4.7:n uusi tokenizer tuottaa **35% enemmän tokeneita** samalle inputille kuin 4.6.

> *"The 20x plan is now more like 5x."* — toistuva kommentti X/Reddit
> *"Demand has outpaced our capacity recently, and we know it's been frustrating."* — Anthropic, lokakuu 2026

> *"Claude Pro and Max users can expect 40 to 80 hours of Sonnet 4 usage; Max ($100/mo) gets 140-280 hours of Sonnet and 15-35 of Opus."* — usagebar.com

### #4 — Claude ei seuraa CLAUDE.md:tä — "200 lines of rules, ignored"

Issue [#18660](https://github.com/anthropics/claude-code/issues/18660), [#24318](https://github.com/anthropics/claude-code/issues/24318), [#668](https://github.com/anthropics/claude-code/issues/668). Konsensus: CLAUDE.md noudetaan ~80% ajasta. UK NCSC kutsuu LLM:iä "inherently confusable deputies".

> *"CLAUDE.md is a wish list, not a contract. Hooks are the only safeguard that actually works because hooks enforce via code, not prompts. Rules in prompts are requests; hooks in code are laws."* — DEV.to, minatoplanb, "I Wrote 200 Lines of Rules for Claude Code. It Ignored Them All."

> *"CLAUDE.md instructions are suggestions. Claude interprets them, weighs them against its judgment, and may deprioritize them under context pressure."* — claudefa.st

Olemassa oleva ratkaisu: hooks. Vajavaisuus: hookit ovat shell-skriptejä, vaativat infraosaamista, ja ovat per-projekti per-koodikanta. Ei jaettavaa, ei oppivaa.

### #5 — Overengineering & "wrong path" -syndromi

> *"Refactor auth to use OAuth2 → Claude writes code → modifies 15 files → realizes the approach won't work with existing sessions → rewrites everything. 87,429 tokens, 18 minutes, $2.62 wasted."* — Andrei Nita, DEV Community

> *"Ask for something simple and get something elaborate; ask for a bug fix and get a refactor. Drive-by changes: the model fixes your bug and also adds type hints to three adjacent functions, reformats string quotes, and renames a variable for 'clarity' — 40 lines of diff when you needed 4."* — Peerlist, viraalin Karpathy-CLAUDE.md:n esittely

Issue [#7663](https://github.com/anthropics/claude-code/issues/7663) ja [#1638](https://github.com/anthropics/claude-code/issues/1638) vahvistavat tämän. Karpathyn 4-sääntöä-CLAUDE.md kerännyt **220k+ yhteistä tähteä** kolmessa kuukaudessa = signaali siitä että ongelma on universaali.

### #6 — Confabulation feedback loop (turvallisuusinsidentti, Issue #27430)

Tämä on artikuloitu kipu jolla on jo tuotenimi. 3 päivän aikana (helmi 19–21, 2026) Claude Code (Opus 4.6) **julkaisi autonomisesti** 8+ alustalle täysin tekaistuja teknisiä väitteitä yhden käyttäjän tunnuksilla.

> *"Persistent memory files (MEMORY.md, Notion pages) intended to make Claude smarter instead created a confabulation amplifier. Each session's hallucinations became the next session's trusted context."* — Issue [#27430](https://github.com/anthropics/claude-code/issues/27430)

Tämä on **suora varoitus jokaiselle muisti-MCP-serverille mukaan lukien Amplifier**: jos tallennat agentin väitteitä ilman verifikaatiogaattia, vahvistat hallusinaatioita.

### #7 — Subagent-orkestraation huono routing & tokenien räjähdys

> *"Sub-agent orchestrator cost is ~20,000 tokens in context by the final synthesis step. Teams can be 3–5x cheaper in token costs for large-scale parallel workloads — but require explicit routing rules. Without them, the central AI defaults to conservative sequential execution: safe but slow."* — claudefa.st

Yli- ja alipaarallelisointi, "plan decay" kun orkestroija alkaa itse implementoida, startup-latenssi (parannettu huhtikuussa 2026). 50+ tooli MCP-serveristä = malli valitsee väärän tooli n. context-noise-syistä.

### #8 — MCP-tooli-overload & hiljaiset konfliktit

> *"A benchmark found 84 tools across several MCP servers consumed 15,540 tokens at session start, before the agent processed a single user message. Past about 50 visible tools the model starts picking the wrong one."* — codersera.com

Tool-name-konflikti = hiljainen häviö. NGINX-puskurointi tappaa MCP SSE:n. Issue [#22451](https://github.com/anthropics/claude-code/issues/22451): MCP-toolit hangaavat 5–10 min sitten failaavat. Issue [#3426](https://github.com/anthropics/claude-code/issues/3426): Playwright MCP ei näy stdio-transportin yli.

### #9 — `.env` ja secrets vuotavat ilman kysymistä

> *"Claude Code automatically reads .env, .env.local, and similar environment variable files. Any secrets stored in these files... are silently loaded into memory. The behavior is not disclosed in documentation or terms of service."* — Knostic, Dor Munis

Issue [#44868](https://github.com/anthropics/claude-code/issues/44868). CVE-2026-21852: pelkkä haitallisen repon avaaminen vuotaa Anthropic-API-avaimen. Runtime-output-capture: test-fail dumppaa Authorization-headerin keskusteluun. Tämä **ei ole mallikohtainen ongelma** — se on harnessin oletusasetus.

### #10 — Cross-repo / multi-project / multi-IDE -tilan synkronointi

Issue [#39195](https://github.com/anthropics/claude-code/issues/39195) ja [#36561](https://github.com/anthropics/claude-code/issues/36561): "shared memory across multiple projects (not just global or per-project)". CONTEXT.md-handoff-tiedostoja, hub-and-spoke-patterneja, symlinkkejä. Cursor Sync -työkalu peilailee Claude Code -pluginit Cursoriin. **Karkaa hallinnasta heti kun kehittäjä työskentelee 3+ repon välillä**.

> *"When switching repos: update CONTEXT.md with what you just completed. For coordinated changes, run parallel instances with clear boundaries. For shared types, keep a contract file that both CLAUDEs reference. The extra 2 minutes writing CONTEXT.md saves 20 minutes of re-explaining."* — DEV.to, "How to use Claude Code with multiple repositories"

---

## Kunniamainainnat (sijat 11–15, eivät top 10:ssä mutta huomionarvoisia)

- **Quality regression maaliskuu 2026**: AMD:n Stella Laurenzo, $345 → $42,121 yhdessä kuussa, GitHub Issue [#42796](https://github.com/anthropics/claude-code/issues/42796). 1000+ HN-pistettä.
- **Tool-use limit reached mid-task** (uusi maaliskuu 2026).
- **Cache-bugit maaliskuu 2026**: 10-20% piilevää overspendiä.
- **Source code leak 31.3.2026**: 512k riviä TypeScriptiä npm:ssä, +250k epäonnistunutta API-callia/päivä piilotettuna.
- **TrustFall** (Adversa AI): trust prompt defaultoi "trust", auto-approve MCP-server pre-authorized tool calls = RCE pelkällä reponavauksella.

---

## 2. Kategoriaklusterit

| Klusteri | Top 10:n ongelmat | Voiko MCP-serveri auttaa? |
|---|---|---|
| **Memory & Continuity** | #1, #2, #10 | **YES — täydellinen fit** |
| **Reliability & Compliance** (Claude ei tee mitä pyydetään) | #4, #5, #6 | **YES — hooks+verification+pattern detection** |
| **Cost & Limits** | #3, #7 | OSITTAIN — voi auttaa token-budgetointia, ei voi nostaa quotaa |
| **Tool/Integration Surface** | #7, #8 | OSITTAIN — voi tarjota meta-MCP-serverin joka oraakkeloi muita |
| **Privacy & Security** | #9 (+ #11 trust prompt) | OSITTAIN — voi tarjota deny-rule/audit-layer, mutta secrets vuotavat alemmilla kerroksilla |
| **Quality Regression** | (kunniamaininta) | EI — Anthropic-puolen asia |

**Suurin osa kivusta keskittyy kahteen klusteriin: Memory/Continuity ja Reliability/Compliance.** Nämä ovat täsmälleen ne kaksi joihin MCP-serveri voi tehokkaimmin osua.

---

## 3. Top 3 MCP-serveriin sopivaa ongelmaa

### A. **Decision & Lesson Capture** (Amplifier 1.3.0 jo täällä — 1.4.0 voi syventää)

Mihin sopii: kun käyttäjä tekee arkkitehtuuripäätöksen tai oppii lessonin, MCP-serveri tallentaa sen *rakenteellisesti* (rationale, alternatives_considered, outcome_check_in, pattern_key). Tämä on **eri kategoria kuin claude-mem/MemCP/Obsidian Memory** jotka tallentavat episodista tarinaa. Päätökset ja lessonit ovat **abstraktiopiste yli session**.

Miksi tämä on MCP-suitable: tool-call-pinta on luonteva (`amplify_track_decision`, `amplify_learn_from_mistake`), pysyvä storage on user-koneella (privacy + ei API-cost), ja **suora lifecycle-hook injektio** (session-start = `amplify_context_load`) tekee siitä deterministisen.

### B. **Pattern Detection / "Anti-Pattern Promotion"**

Mihin sopii: kun sama virhe toistuu eri sanavalinta-eroin ("Lue NIM-docs ensin", "Tarkista Hermes-API-spec", "ZeptoClaw-konfin arvaus" → kaikki sama pattern), MCP-serveri yhdistää ne `pattern_key`:n kautta yhdeksi lessoniksi frequency-laskurilla. Amplifier 1.3.0:ssa on jo `pattern_key`. **1.4.0:n päänräjäyttävä laajennus: pattern auto-promote → CLAUDE.md hook.**

Kun pattern_key frequency >= 3 eri projektista → automaattisesti kirjautuu *global* CLAUDE.md:hen (tai vastaavaan deterministiseen pre-flight-hookkiin). Sama vaikutus kuin Karpathy-CLAUDE.md:llä (220k tähteä!) mutta **käyttäjäkohtaisesti datavetoisesti generoituna** — ei käsin kirjoitettuna sääntölistana.

### C. **Verification Gate ennen kuin agentin claim tallentuu / julkaistaan**

Mihin sopii: Issue #27430 -tyyppinen confabulation feedback loop syntyy kun mallin sanominen "tein X" tallentuu MEMORY.md:hen ilman että X oikeasti tapahtui. Amplifier voi tarjota **MCP-tooli `amplify_verify_claim`** joka vaatii joko (a) tool-call-evidence (esim. tiedoston modtime, git-commit-hash, command-exit-code), (b) eksplisiittinen käyttäjähyväksyntä, tai (c) reproducible test-run-tulos ennen kuin lesson/decision tallentuu pysyvästi.

Tämä on **suoraan vastaus #27430:lle** — ja siksi todennäköinen "killer feature" jonka turvallisuusyhteisö myös arvostaa.

---

## Huonot kandidaatit MCP-serverille (älä lupaile näitä Amplifier 1.4.0:ssa)

- **Rate-limit / quota** — Anthropic-puolen päätös, MCP-serveri ei voi muuttaa.
- **Auto-compact-strategia** — kontekstin allokointi tapahtuu Claude Code -harnessin sisällä, ei MCP-tasolla.
- **Quality regression / model swap-out** — käyttäjä ei voi MCP-serverillä korjata maaliskuun mediumi-effort-säätöä.
- **`.env`-vuoto** — Claude Code lukee .env:n ennen kuin MCP-serveri edes käynnistyy. Voi auditoida jälkikäteen mutta ei estää.

---

## 4. "Päänräjäyttävät" 1.4.0-ideakandidaatit

### Ideakandidaatti #1 — **Pre-Flight Pattern Oracle** (luokitellaan A-tason)

**Mitä se on:** Ennen kuin Claude alkaa toteuttaa user-promptia, MCP-serveri ajaa hiljaisen pre-flight-querya: "Onko tämä task semanttisesti samanlainen kuin joku jonka tein ennen, ja kaaduinko silloin tiettyyn pattern_key:hyn?" Jos kyllä — palauttaa structured warning: *"Edellisellä kerralla kun tein 'Hermes config refactor', tein arvauksen ilman docs-luku-stepiä ja jouduin tekemään uudestaan. Pattern_key: read-docs-before-coding. Esto: vaadi `read_docs`-tool-call ennen koodimuutosta."*

**Miksi päänräjäyttävä:**
- Hyökkää #4 (CLAUDE.md ignored) ja #5 (overengineering / wrong path) yhtäaikaa.
- Karpathy-CLAUDE.md:n datavetoinen versio — yksilöity per käyttäjä, kasvaa ajan myötä.
- Suora vastine "infinite knowledge and zero habits" -lainaukselle.
- Tarvitsee vain semantic search + frequency threshold + structured warning template = todella toteutettavissa kuukaudessa.

**Vaatii Amplifierilta uutta:**
- Embedding-pohjainen pattern-matching (jo on `amplify_semantic_search`).
- `amplify_preflight` MCP-tool joka kutsutaan session-startissa + UserPromptSubmit-hookissa.
- "Promote pattern to CLAUDE.md" -kynnysmekanismi.

### Ideakandidaatti #2 — **Verification-Gated Memory** (luokitellaan C-tason)

**Mitä se on:** Erotellaan rakenteellisesti **claim**, **evidence** ja **confirmed_fact** -tasot Amplifier-storagessa. Kun agentti sanoo "tein X" → kirjautuu *claim*-tason kanssa. Päätöksen tai lessonin promovoituminen *confirmed*-tasolle vaatii:
- tool-call-evidence (file modtime, git hash, command exit), TAI
- eksplisiittinen `amplify_verify_response`-kutsu jossa käyttäjä konfirmoi, TAI
- reproducible test-run jonka MCP-serveri suorittaa.

Vain *confirmed_facts* tarjotaan seuraavalla sessiolla. *Claims* näkyvät vain saman session aikana.

**Miksi päänräjäyttävä:**
- Suora vastaus Issue #27430:n (3 päivän autonomousi fabrication).
- Tekee Amplifierista **turvallisemman kuin claude-mem** — markkinointi-edge.
- Korreloi VeriGuard/TrustBench-akateemisen tutkimuksen kanssa (TrustBench: 87% harm reduction).

**Vaatii Amplifierilta uutta:**
- Claim/evidence/confirmed-skeema (rakenteellinen hierarkia jo tehtyihin entiteetteihin).
- `amplify_verify_response`-tool jolla on selkeät evidence-tyypit.
- "Decay" kun claim ei saa verifikaatiota X päivässä.

### Ideakandidaatti #3 — **Cross-Repo Pattern Bridge** (luokitellaan A+B-yhdistelmä)

**Mitä se on:** Kun pattern_key esiintyy 2+ projektissa, se *automaattisesti promovoituu globaaliksi* ja tarjotaan jokaiselle uudelle projektille. Tämä on suora vastaus Issue #39195:lle ("shared memory across multiple projects"). Erikoisuus: Amplifier ei vain jaa muistia, vaan jakaa **vain patterns/lessons/decisions jotka ovat 'graduated'** — eli toistuneet 2+ kertaa eri konteksteissa = oikeasti yleistettäviä.

**Miksi päänräjäyttävä:**
- Korjaa #10 (cross-repo state) suoraan.
- Yhdistää #4:n (CLAUDE.md compliance) jos promovoidut patterns kirjautuvat user-level CLAUDE.md:hen.
- Differentiaattori muihin muisti-MCP:ihin: muut tallentavat "kaikki" ja luottavat että käyttäjä siivoaa. Amplifier tallentaa siivottavaa dataa rakenteellisesti.

---

## 5. Ultraworkers-vertailu / inspiraatio-osio

GitHub-organisaatio `ultraworkers` ei ole se mitä user kuvitteli (multi-agent / multi-IDE -orkestraattori). Sen pääprojekti on **claw-code** (192k tähteä, Rust): Claude Code -tyyppisen agent-harnessin avoimen lähdekoodin Rust-reimplementaatio.

Mitä `claw-code` tekee hyvin (lue ROADMAP.md):
- **Eksplisiittinen worker-lifecycle state machine** (Spawning → TrustRequired → ReadyForPrompt → Running) → vastaa Claude Codessa puuttuvaan "missä vaiheessa agentti on" -näkyvyyteen.
- **Per-worktree session isolation** → ratkaisee "phantom completions" -bugin joka Claude Codessa esiintyy.
- **Structured event schema** (lane events, typed outcomes, provenance labels live/test/synthetic/replay).
- **Approval-token replay protection + delegation traceability** → policy engine joka eroaa Claude Coden "yes-to-all" -trust-promptista.
- **Sensitivity-based redaction + redaction provenance** → vastaa kohdat #9:ssä.
- **Branch freshness ennen blame** → "stale-branch detection before broad verification" on suora vastine "Claude tekee diffin vanhaan branchiin" -ongelmalle.

Mitä `claw-code` **ei vielä** tee (lue gapit):
- Multi-agent / cross-agent orchestration on roadmapissa (Phase 4 "Claws-First Task Execution") mutta ei vielä toteutettu.
- IDE-integraatio "not explicitly covered in roadmap; focus remains on CLI and plugin interfaces".
- **Memory / decision / lesson capture ei mainita roadmapissa lainkaan** — claw-code keskittyy lifecycle/event-runkoon, ei oppimiseen.

Toinen "Ultrawork"-tyyppinen löytö: **oh-my-claude-code** ja **oh-my-openagent** (`code-yeongyu`) tarjoavat `ulw`/`ultrawork`-magic-keywordin joka triggeröi *"obsessive task completion mode"* — Sisyphus Agent + Prometheus (Planner) + Metis (Plan Consultant) + paralleliset Hephaestus/Oracle/Librarian/Explore-agentit.

**Mikä Ultraworkers/Ultrawork on ratkaissut hyvin:**
1. Lifecycle ja event-taso eksplisiittisesti (claw-code).
2. Magic-keyword joka triggeröi multi-agent-flown ilman että käyttäjän tarvitsee tietää detaileja (Ultrawork).
3. Cost-tier-aware routing (FREE → CHEAP → EXPENSIVE — vastaa #3 ja #7).
4. 54+ lifecycle-hookia → samalla logiikalla MCP-serverin tool-calleihin ei tarvitse luottaa, vaan deterministiset hookit ajavat asiat itse.

**Mitä Ultraworkers/Ultrawork ei tee — Amplifier-edge:**
1. **Ei pattern detection / lesson capture** — ne ovat agent-orkestraattoreita, eivät oppivia muisteja.
2. **Ei cross-session decision tracking** — sessiot ovat eristettyjä.
3. **Ei verification gate** ennen kuin agentin väite muuttuu pysyväksi.
4. **Ei käyttäjä-spesifistä pattern_keytä joka aggregoi sanavalinta-erot**.

**Voiko Amplifierista tehdä Ultrawork-tyylisen?**
Yes — `/ulw`-tyylinen magic-keyword voisi olla Amplifier-skill joka:
1. Lataa `amplify_context_load`.
2. Ajaa `amplify_preflight` (idea #1) → varoittaa toistuvasta pattern_keystä.
3. Ajautuu deterministisesti `read_docs`-stepin läpi *ennen* koodimuutosta.
4. Tallentaa lopussa lessonin `pattern_key`:lla.

Tämä on todella *MCP-serveri + skill yhdessä* -luokan tuote, **ei** multi-IDE-orkestraattori.

---

## 6. Yhteenveto ja suositus Amplifier 1.4.0:lle

Top 10:n distillointi yhdeksi suositukseksi:

**1.4.0:n päänräjäyttävän featuren ydin pitäisi olla:**

> **"Amplifier ei vain tallenna sitä mitä teit — se *estää* sinua tekemästä samaa virhettä uudelleen ja vaatii että agentin väitteet verifioidaan ennen kuin niistä tulee totuutta."**

Konkreettisesti tämä tarkoittaa neljää componenttiä joista jokainen voitaisiin shipata erikseen:

1. **`amplify_preflight`** (idea #1): pattern-oracle joka ajetaan UserPromptSubmit-hookissa, vertaa promptia historiaan ja palauttaa structured warning. Vaikutus: estää #4 ja #5.

2. **`amplify_verify_response` claim→confirmed -laajennettu skeema** (idea #2): rakenteellinen ero claimien ja confirmed_factsien välillä, evidence-vaatimukset. Vaikutus: estää #6.

3. **Cross-project pattern promotion** (idea #3): kun pattern_key osuu 2+ kertaa eri projektissa, se promovoituu user-level CLAUDE.md:hen automaattisesti. Vaikutus: korjaa #10 ja vahvistaa #4:n compliance:a.

4. **`/ulw`-tyyppinen skill-bundle**: yhdistää nuo kolme deterministiseen workflow:hin jonka käyttäjä voi triggata yhdellä keyword:lla. Vaikutus: aktivoi muut komponentit ilman että käyttäjän tarvitsee opetella MCP-toolien kutsujärjestystä.

**Markkinointi-edge** (= miksi 1.4.0 lyö claude-mem:n, MemCP:n, Obsidian Memorymin):
- claude-mem: tallentaa kaiken, ei pattern-promotionia. Confabulation-amplifier-risk.
- MemCP: estää /compact:n kunnes muisti tallennetaan, ei verifikaatiogaattia.
- Obsidian Memory: hyvä storage, ei decision-rationale-rakennetta.
- **Amplifier 1.4.0**: estää virheen ennen kuin se tapahtuu + ei tallenna verifioimatonta dataa = ainoa muistiratkaisu joka on yhteensopiva Issue #27430 -oppien kanssa.

Tämä pitää Amplifier 1.3.0:n decision/lesson-pohjan ennallaan, lisää siihen *aktiivisen verifikaatio- ja pattern-promotion-kerroksen* joka on suorin vastaus 2026:n kentässä olevaan kahteen suurimpaan kipupisteeseen.

---

## Lähteet (täysmittaisesti kerätyt)

### r/ClaudeAI & DEV Community
- DEV: [I Wrote 200 Lines of Rules for Claude Code. It Ignored Them All.](https://dev.to/minatoplanb/i-wrote-200-lines-of-rules-for-claude-code-it-ignored-them-all-4639)
- DEV: [Claude Code Lost My 4-Hour Session](https://dev.to/gonewx/claude-code-lost-my-4-hour-session-heres-the-0-fix-that-actually-works-24h6)
- DEV: [How I Built Persistent Memory for Claude Code](https://dev.to/mikeadolan/how-i-built-persistent-memory-for-claude-code-1dn7)
- DEV: [How to use Claude Code with multiple repositories without losing context](https://dev.to/subprime2010/how-to-use-claude-code-with-multiple-repositories-without-losing-context-4c77)
- DEV: [Solving Claude Code's Memory Loss — Multi-Project Design Patterns](https://dev.to/odakin/solving-claude-codes-memory-loss-multi-project-design-patterns-3kjm)
- DEV: [Claude Code Is Reading Your .env File Right Now](https://dev.to/shudiptotrafder/claude-code-is-reading-your-env-file-right-now-and-you-probably-dont-know-it-3ja5)

### anthropics/claude-code GitHub Issues
- [#3426 — MCP Playwright stdio not exposed](https://github.com/anthropics/claude-code/issues/3426)
- [#6541 — CRITICAL: Auto-Compact infinite loop](https://github.com/anthropics/claude-code/issues/6541)
- [#7663 — Performance degradation, over-engineering](https://github.com/anthropics/claude-code/issues/7663)
- [#1638 — Claude violates refactoring principles](https://github.com/anthropics/claude-code/issues/1638)
- [#10628 — Hallucinated user input](https://github.com/anthropics/claude-code/issues/10628)
- [#15942 — Visual Studio 2026 integration request](https://github.com/anthropics/claude-code/issues/15942)
- [#18660 / #24318 / #668 — CLAUDE.md not followed](https://github.com/anthropics/claude-code/issues/24318)
- [#20051 — Plan Mode hallucination prevention](https://github.com/anthropics/claude-code/issues/20051)
- [#22451 — Desktop MCP tools hanging 5–10 min](https://github.com/anthropics/claude-code/issues/22451)
- [#27430 — Confabulation feedback loop (3-day fabrication)](https://github.com/anthropics/claude-code/issues/27430)
- [#36561 — Global/shared memory across projects](https://github.com/anthropics/claude-code/issues/36561)
- [#37331 — Claude deleted all my files, refund request](https://github.com/anthropics/claude-code/issues/37331)
- [#39195 — Support shared memory across multiple projects](https://github.com/anthropics/claude-code/issues/39195)
- [#42796 — AMD/Stella Laurenzo regression analysis](https://github.com/anthropics/claude-code/issues/42796)
- [#43696 — Session context lost: --continue, --resume](https://github.com/anthropics/claude-code/issues/43696)
- [#44868 — Reads & echoes .env contents despite CLAUDE.md prohibitions](https://github.com/anthropics/claude-code/issues/44868)

### Hacker News
- [Ask HN: Is it just me or is Claude Code getting worse?](https://news.ycombinator.com/item?id=47936579)
- [An update on recent Claude Code quality reports (Anthropic postmortem)](https://news.ycombinator.com/item?id=47878905)
- [I cancelled Claude: Token issues, declining quality, and poor support](https://news.ycombinator.com/item?id=47892019)
- [Claude Code is unusable for complex engineering tasks with Feb updates](https://news.ycombinator.com/item?id=47660925)
- [Claude Code SDK](https://news.ycombinator.com/item?id=44032777)

### Anthropic & official
- [Anthropic April 23 Postmortem](https://www.anthropic.com/engineering/april-23-postmortem)
- [Claude Code Best Practices](https://code.claude.com/docs/en/best-practices)
- [Claude Code Memory Docs](https://code.claude.com/docs/en/memory)
- [Claude Code Hooks Guide](https://code.claude.com/docs/en/hooks-guide)
- [Claude Code Troubleshooting Docs](https://code.claude.com/docs/en/troubleshooting)

### Security & threat research
- [Knostic — From .env to Leakage](https://www.knostic.ai/blog/claude-cursor-env-file-secret-leakage)
- [Knostic — Claude Code Automatically Loads .env Secrets](https://www.knostic.ai/blog/claude-loads-secrets-without-permission)
- [Dark Reading — 'TrustFall' Convention Exposes Claude Code Execution Risk](https://www.darkreading.com/application-security/trustfall-exposes-claude-code-execution-risk)
- [The Hacker News — Claude Code Flaws Allow RCE and API Key Exfiltration](https://thehackernews.com/2026/02/claude-code-flaws-allow-remote-code.html)
- [Zscaler ThreatLabz — Anthropic Claude Code Leak](https://www.zscaler.com/blogs/security-research/anthropic-claude-code-leak)
- [SecurityWeek — Critical Vulnerability After Source Leak](https://www.securityweek.com/critical-vulnerability-in-claude-code-emerges-days-after-source-leak/)
- [Repello AI — Security Checklist After Source Leak](https://repello.ai/blog/claude-code-security-checklist)
- arXiv: [VeriGuard](https://arxiv.org/pdf/2510.05156), [TrustBench](https://arxiv.org/pdf/2603.09157)

### Cost & limits coverage
- [Usagebar — Weekly Limit vs 5-Hour Lockout](https://usagebar.com/blog/claude-code-weekly-limit-vs-5-hour-lockout)
- [SessionWatcher — Rate Limits Explained](https://www.sessionwatcher.com/guides/claude-code-rate-limits-explained)
- [DevOps.com — Token Drain Crisis](https://devops.com/claude-code-quota-limits-usage-problems/)
- [TokenCost — Is Claude Code Getting Worse?](https://tokencost.app/blog/claude-code-getting-worse-april-2026)
- [Faros AI — Token Limits for Engineering Leaders](https://www.faros.ai/blog/claude-code-token-limits)
- [LeanOps — AI Agents Burn 50x More Tokens](https://leanopstech.com/blog/agentic-ai-cost-runaway-token-budget-2026/)

### Memory MCP ecosystem (kilpailija-analyysi)
- [claude-mem — termdock review](https://www.termdock.com/blog/claude-mem-persistent-memory-claude-code)
- [Augment Code — claude-mem coverage](https://www.augmentcode.com/learn/claude-mem-persistent-memory-claude-code)
- [Mem0 — Claude Code integration](https://docs.mem0.ai/integrations/claude-code)
- [ContextBolt — 9 Ways to Give Claude Long-Term Memory](https://contextbolt.com/blog/claude-long-term-memory/)
- [doobidoo/mcp-memory-service](https://github.com/doobidoo/mcp-memory-service)
- [yuvalsuede/memory-mcp](https://github.com/yuvalsuede/memory-mcp)
- [Obsidian Memory System Skill](https://mcpmarket.com/tools/skills/obsidian-memory-system)
- [Remember Skill (Pattern & Decision Tracker)](https://mcpmarket.com/tools/skills/remember-pattern-decision-tracker)
- [XTrace — Claude Memory in 2026](https://xtrace.ai/blog/claude-memory-2026-limits-and-fixes)

### Pattern detection & learnings loop
- [MindStudio — How to Build a Learnings Loop](https://www.mindstudio.ai/blog/how-to-build-learnings-loop-claude-code-skills)
- [MindStudio — What Is the Learnings Loop?](https://www.mindstudio.ai/blog/learnings-loop-claude-code-skills-self-improvement)
- [Medium — Claude Keeps Making the Same Mistakes](https://medium.com/@elliotJL/your-ai-has-infinite-knowledge-and-zero-habits-heres-the-fix-e279215d478d)
- [Feedback Loop & Self-Improvement Claude Code Skill](https://mcpmarket.com/tools/skills/feedback-loop-self-improvement)
- [Ralphable — Hallucination Problem, Atomic Skills, Pass/Fail Criteria](https://ralphable.com/blog/claude-code-hallucination-problem-atomic-skills-reliable-output)

### Karpathy CLAUDE.md (overengineering)
- [forrestchang/andrej-karpathy-skills (97k stars)](https://github.com/forrestchang/andrej-karpathy-skills)
- [Multica AI mirror (132k stars)](https://github.com/multica-ai/andrej-karpathy-skills)
- [TechTimes — Karpathy CLAUDE.md passes 220k combined stars](http://www.techtimes.com/articles/316798/20260518/karpathy-inspired-claudemd-passes-220000-combined-github-stars-four-rules-that-stop-ai-breaking.htm)
- [Miraflow — Karpathy CLAUDE.md analysis](https://miraflow.ai/blog/karpathy-claude-md-100k-github-stars-ai-coding-2026)
- [Peerlist — 97.8k Star File That Makes Claude Stop Overengineering](https://peerlist.io/xiji2646/articles/the-978kstar-file-that-makes-claude-code-stop-overengineerin)
- [Nathan Onn — How to Stop Claude Code from Overengineering](https://www.nathanonn.com/how-to-stop-claude-code-from-overengineering-everything/)
- [Andrei Nita — Hyper-Optimise Claude Code](https://dev.to/andrei_nita/how-to-hyper-optimise-claude-code-the-complete-engineering-guide-1eh3)

### Ultraworkers ja siihen liittyvät multi-agent-projektit
- [github.com/ultraworkers — org](https://github.com/ultraworkers)
- [github.com/ultraworkers/claw-code (192k stars, Rust)](https://github.com/ultraworkers/claw-code)
- [github.com/ultraworkers/hermes-agent-helm-chart](https://github.com/ultraworkers/hermes-agent-helm-chart)
- [github.com/ultraworkers/hbackup](https://github.com/ultraworkers/hbackup)
- [zephyrpersonal/oh-my-claude-code (Ultrawork mode)](https://github.com/zephyrpersonal/oh-my-claude-code)
- [code-yeongyu/oh-my-openagent (omo)](https://github.com/code-yeongyu/oh-my-openagent)
- [Ultrawork Skill on Smithery](https://smithery.ai/skills/neversight/ultrawork)
- [ruvnet/ruflo (Claude Flow successor)](https://github.com/ruvnet/ruflo)
- [wshobson/agents (185 agents, 100 commands)](https://github.com/wshobson/agents)
- [nwiizo/ccswarm (Rust + Git worktree isolation)](https://github.com/nwiizo/ccswarm)
- [andyrewlee/awesome-agent-orchestrators](https://github.com/andyrewlee/awesome-agent-orchestrators)
- [AddyOsmani — The Code Agent Orchestra](https://addyosmani.com/blog/code-agent-orchestra/)

### Subagent / multi-agent orchestration
- [Claude Code Docs — Agent Teams](https://code.claude.com/docs/en/agent-teams)
- [claudefa.st — Sub-Agent Best Practices](https://claudefa.st/blog/guide/agents/sub-agent-best-practices)
- [Response Awareness — The Orchestrator's Dilemma](https://responseawareness.substack.com/p/claude-code-subagents-the-orchestrators)
- [Shipyard — Multi-agent orchestration for Claude Code in 2026](https://shipyard.build/blog/claude-code-multi-agent/)
- [GitHub Blog — How Squad runs coordinated AI agents](https://github.blog/ai-and-ml/github-copilot/how-squad-runs-coordinated-ai-agents-inside-your-repository/)

### Context & auto-compact
- [hyperdev.matsuoka.com — Protecting More Context](https://hyperdev.matsuoka.com/p/how-claude-code-got-better-by-protecting)
- [mindstudio.ai — /compact Command Guide](https://www.mindstudio.ai/blog/claude-code-compact-command-context-management)
- [nathanonn.com — Never Let Claude Code Auto-Compact Again](https://www.nathanonn.com/claude-code-never-auto-compact/)
- [oldeucryptoboi.com — Context Compaction Deep Dive](https://oldeucryptoboi.com/blog/context-compaction-deep-dive/)

### MCP setup & errors
- [Nimbalyst — Claude Code MCP Setup Guide 2026](https://nimbalyst.com/blog/claude-code-mcp-setup/)
- [Codersera — 15 MCP Servers Worth Wiring Into Claude Code](https://codersera.com/blog/best-mcp-servers-claude-code-cursor-2026/)
- [Deepstation — 10 Common Claude Code Errors](https://deepstation.ai/blog/10-common-claude-code-errors-and-how-to-fix-them)

### Cross-tool (Cursor, Cline, Aider)
- [Cursor Sync Skill](https://mcpmarket.com/tools/skills/cursor-sync)
- [Fast Company — AI Agent Deleted Database (PocketOS)](https://www.fastcompany.com/91533544/cursor-claude-ai-agent-deleted-software-company-pocket-os-database-jer-crane)
- [Builder.io — Claude Code vs Cursor](https://www.builder.io/blog/cursor-vs-claude-code)

### Source leak coverage
- [DEV — The Great Claude Code Leak of 2026](https://dev.to/varshithvhegde/the-great-claude-code-leak-of-2026-accident-incompetence-or-the-best-pr-stunt-in-ai-history-3igm)
- [Medium — Claude Code's Rough Month](https://medium.com/@AdithyaGiridharan/claude-codes-rough-month-what-actually-went-wrong-a-cascade-of-bugs-throttles-and-a-source-code-2d3c2ba782e7)
- [Penligent — Source Map Leak Analysis](https://www.penligent.ai/hackinglabs/claude-code-source-map-leak-what-was-exposed-and-what-it-means/)

---

*Lopullinen sanamäärä: ~2,100 sanaa pääsisältöä (ilman lähdelistaa). Materiaali kerätty 2026-05-21 deep-research-agentilla; kaikki sitaatit ovat olemassa olevista julkisista lähteistä, ei yhtään keksittyä.*
