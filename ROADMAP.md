# Roadmap

Three phases: prove it on one household (this one), validate it survives other households (beta), then decide whether it's worth productising.

## Phase 1 — Personal use

Goal: replace "open the fridge and guess" with a system that's actually faster than guessing, for one household, end to end.

- [x] Supabase schema (`households`, `members`, `items`, `transactions`, `shopping_list`) with RLS
- [x] `/tap` and `/tap/[location]` — sub-5-second, no-login stock update
- [ ] Initial stock scan (camera → Claude vision → confirm → opening stock)
- [ ] Inventory dashboard (traffic-light status, grouped by location, search)
- [ ] Passive consumption logic (daily expiry sweep → auto Out + waste transaction)
- [ ] Expiry alerts (grouped, push + WhatsApp)
- [ ] WhatsApp/SMS intelligence layer (receipt photo, NL query, NL update, Sunday check-in)
- [ ] Receipt scanning with fuzzy-match against known items + UK supermarket naming
- [ ] PWA installable on iOS/Android, offline inventory view

**Exit criteria:** the NFC tags are on the doors, used daily without thinking about it, and the dashboard is trusted enough that a physical fridge check becomes unnecessary for "what's in there."

## Phase 2 — Beta

Goal: prove the model generalises beyond one household's items, habits, and supermarket.

- [ ] Multi-household isolation tested with 3-5 real external households
- [ ] Onboarding flow that doesn't require explanation (the initial scan has to be self-evident)
- [ ] Item taxonomy generalised beyond one household's pantry (categories, units, common items list)
- [ ] Receipt parsing tested against multiple UK supermarkets (Tesco, Sainsbury's, Aldi, Lidl formats differ)
- [ ] Inferred expiry days tuned from real usage data, not just guesses
- [ ] WhatsApp onboarding (number registration, opt-in flow) productionised — Twilio sandbox → real number
- [ ] Error/edge-case handling: misread receipts, ambiguous photos, duplicate items, tag mis-taps
- [ ] Feedback loop: are auto-Out and expiry predictions actually right? Track false positive/negative rate

**Exit criteria:** 3+ households using it for 2+ weeks without needing you to fix something for them.

## Phase 3 — Product

Goal: decide if this is a real product, and if so, ship it as one.

- [ ] Pricing model (likely per-household subscription, WhatsApp/Twilio costs are the main marginal cost to manage)
- [ ] Self-serve onboarding (sign up → NFC tag ordering/instructions → first scan, no manual setup)
- [ ] NFC tag fulfilment (pre-programmed tags shipped to user, or a generic landing tag + setup flow)
- [ ] Billing (Stripe), account management, household invites
- [ ] Support for the inevitable "why does it think I'm out of X" disputes — transaction history UI
- [ ] Scale Supabase plan / Twilio plan past free tiers, cost-per-household modelling
- [ ] Marketing site distinct from the app itself

**Exit criteria:** a stranger can sign up, get a tag, and have working stock tracking within a day, with zero involvement from you.
