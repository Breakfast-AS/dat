# Det Andre Teatret – produktfeed

Lager `docs/feed.csv` med én rad per forestilling i [programmet](https://detandreteatret.no/program).
GitHub Actions kjører hver time og publiserer filen via GitHub Pages.

## Hva skjer hver time

1. Henter alle sidene i programmet og alle spilletider med billettkode.
2. Henter billettstatus fra Tickster. En spilletid er i salg hvis den har «Kjøp»-knapp.
3. Leser tittel, tekst, pris, farger, bilde osv. fra hver forestillingsside.
4. Skriver `docs/feed.csv` og committer bare hvis noe er endret.

**ticket_status**
- `in stock` når minst én kommende spilletid kan kjøpes
- `out of stock` når alle spilletider er utsolgt eller stengt, eller når forestillingen er borte fra programmet

Feiler noe underveis (nettsiden eller Tickster nede), stopper jobben uten å endre feeden.
GitHub sender da e-post om at jobben feilet.

## Manuelle justeringer

Legg overstyringer i `src/overrides.json`, med id som nøkkel:

```json
{
  "maestro-impro": { "promo": "no" },
  "jazz-emu": { "price": "450", "description": "Egen tekst til annonsene" }
}
```

## Kjør lokalt

```sh
node src/build-feed.mjs   # krever Node 22+
```

## id

`id` er URL-sluggen der æ/ø/å er byttet ut med ae/o/a (`jævla-klassiker` → `jaevla-klassiker`),
samme regel som GTM-scriptet for Meta-pikselen bruker.
# dat
