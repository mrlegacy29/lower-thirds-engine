# SDI fill + key — DeckLink → ATEM setup

Send the lower thirds straight out the DeckLink as a **fill + key pair** and let the ATEM
key them. No OBS in the graphics path, so **Program and every Aux both get the graphic**
with no compositing latency — in-house screens and the stream stay in sync with the stage.

---

## 0. Read this first — the one real constraint

**Your ATEM keyer count is not the limit. The card is.**

The DeckLink 8K Pro's connector mapping is **card-wide** — changing one connector changes
all of them. The mapping that gives a proper fill+key pair is the default
`SDI 1 & 2 In, SDI 3 & 4 Out`, which produces **exactly one** output sub-device with two
connectors. That is **one fill+key pair, total**.

The other modes don't help:

| Mapping | What you get | Keying |
|---|---|---|
| **SDI 1&2 In, SDI 3&4 Out** *(default)* | 1 in + 1 out, two connectors on the output sub-device | ✅ one fill+key pair |
| SDI 1 to 4 In or Out | all four one direction (this is the 8K mode) | ✗ |
| SDI 1 In, SDI 2 Out | 2 in + 2 out, but as *separate* sub-devices | ⚠️ needs separate-device keying — known to drift out of sync |
| SDI 1 In or Out | most flexible | ✗ **does not allow ARGB keying** |

So a card output is an **exclusive resource**, and ProPresenter's alpha keyer is currently
holding yours. You must pick one:

- **Path A — this engine replaces ProPresenter's lower thirds.** Free, today. ProPresenter
  keeps doing lyrics and full-screen content on its normal outputs and keeps feeding this
  app over the API; it just stops being the lower-thirds renderer. That is the whole point
  of the product, so this is usually the right call.
- **Path B — run both independently.** Add a **DeckLink Duo 2** or **Quad 2** (the cards
  actually designed for key/fill). ProPresenter keeps the 8K Pro pair; this engine gets a
  pair on the new card. Your 4 USK + 4 DSK have plenty of room for both.

Everything below is written for Path A. For Path B it is identical, you just pick the new
card in step 5 and leave ProPresenter alone.

---

## 1. Install the DeckLink bridge (one time)

The app talks to the card through `macadam`, which must be compiled against Blackmagic's
SDK. It is deliberately **not** a normal dependency — it can't build without the SDK, and a
failed build must never be able to break a release.

1. Blackmagic **Desktop Video** is already installed (it's driving your card today).
2. Download the **Desktop Video SDK** from <https://www.blackmagicdesign.com/support>.
3. Unzip it, then:

```bash
set BLACKMAGIC_SDK_PATH=C:\path\to\Blackmagic DeckLink SDK
npm install macadam
```

Until this is done the app's SDI panel tells you exactly this, and offers the OBS fallback
instead of failing silently.

---

## 2. Free the card (Path A only)

In **ProPresenter → Settings → Display / Output**, turn **off** the alpha-key output that is
currently using the DeckLink.

If you skip this, the app's lamp goes **red** with *"device in use"* — the card can only be
opened by one application at a time.

---

## 3. Set the connector mapping

Open **Blackmagic Desktop Video Setup** → your card → the gear icon.

- **Connector mapping:** `SDI 1 & 2 In, SDI 3 & 4 Out`
- Confirm the output sub-device is using **two** connectors (that's what makes fill+key
  possible rather than a single fill-only output).

Desktop Video Setup labels which connector is fill and which is key. **Note what it says** —
don't assume. Step 8 gives you a visual confirmation either way.

---

## 4. Cable it

Two SDI cables from the card's **output** connectors to two spare ATEM inputs:

```
DeckLink SDI 3  ──►  ATEM input  (FILL — the graphic in colour)
DeckLink SDI 4  ──►  ATEM input  (KEY  — white silhouette on black)
```

Write down which ATEM input numbers you used; you need them in step 7. If the two end up
swapped, step 8 will show you immediately and you just swap the cables (or swap the sources
in the ATEM keyer).

---

## 5. Configure the app

In the console: **Output & keying → SDI fill + key — DeckLink → ATEM**

1. **DeckLink device** — pick your card.
2. **Video mode** — ⚠️ **must match the ATEM exactly.** A mismatch shows up as flicker or a
   black key. Match whatever your ProPresenter alpha output was set to (very likely
   **1080p 59.94** or **1080i 59.94**).
3. **Key level** — leave at 255 (fully opaque). Lower it to fade the whole key.
4. Also set **Background = Transparent** at the top of the same section. Chroma green /
   black are for luma-keying, and would defeat the alpha key.
5. Press **Start SDI output**.

These settings are stored per-machine and deliberately **never travel in a Take** — changing
the video mode won't light up the TAKE button or push a card setting to another PC.

---

## 6. Read the lamp

| Lamp | Meaning |
|---|---|
| 🟢 **KEY + FILL OK** | Card is open in external-key mode and taking frames steadily |
| 🟡 **SENDING — CHECK WARNINGS** | On air, but something is worth knowing (no genlock, dropped frames, card didn't report external-keying support) |
| 🔴 **NOT SENDING** | Nothing is going out — the named check tells you which thing failed |

Each check is listed individually, so a fault **names itself** instead of just going red:
bridge installed · card open · external keyer enabled · page rendering · card accepting
frames · no dropped frames · genlock.

**Honest limit:** SDI is one-way. Green means *this card is sending a valid fill+key pair*.
Nothing downstream reports back, so the app **cannot** know your cables reach the ATEM or
that the keyer is configured. That's what step 8 is for.

---

## 7. Set up the ATEM keyer

Pick any upstream (USK) or downstream (DSK) keyer:

- **Fill Source** → the ATEM input carrying **fill**
- **Key Source** → the ATEM input carrying **key**
- **Key Type** → `Luma`
- **Pre Multiplied Key** → **ON** ← required

Pre-multiplied matters because Chromium composites the page with pre-multiplied alpha, which
is the same reason ProPresenter's alpha keyer needs it. With it off you get dark fringing
around the text edges.

Then put the keyer **ON AIR**. Because the key happens inside the ATEM, Program *and* every
Aux carry it — stream and in-house both, no OBS latency.

---

## 8. Prove it — the test pattern

Click **Send test pattern (10s)**. It puts colour bars with a **transparent centre box** on
the output. On the ATEM multiview:

- the **fill** input shows the bars **in colour**
- the **key** input shows a **white silhouette on black**
- with the keyer on air, the **centre box keys through** to whatever is underneath

If fill and key look swapped, swap the two cables or swap the sources in the ATEM keyer.
If the centre box does *not* key through, Pre-Multiplied Key is probably off, or Background
isn't set to Transparent.

---

## Troubleshooting

| Symptom | Cause |
|---|---|
| Red — *"device in use"* | ProPresenter's alpha keyer still holds the card (step 2), or another copy of the app is running |
| Red — *"wouldn't open for fill+key"* | Connector mapping isn't a two-connector output sub-device (step 3), or the mode isn't supported for keying on this card |
| Flicker, rolling, or intermittent black | Video mode doesn't match the ATEM (step 5) |
| Graphic on air but no transparency | Background isn't Transparent, or Pre-Multiplied Key is off, or Key Source points at the fill input |
| Dark fringe around text | Pre-Multiplied Key is off |
| Amber — no genlock | Fine for graphics. Feed the card a reference if you want it rock-steady over a long service |
| Amber — dropped frames | The graphics PC is struggling; try a lower frame-rate mode |
| Panel says the bridge isn't installed | Step 1 |

---

## If you'd rather not install the bridge yet

OBS can drive the same card today:

1. Browser source → `http://localhost:7777/output`, 1920×1080
2. **Settings → Advanced → Color Format = `RGB`** ← without this there is no alpha
3. **Tools → DeckLink Output** → your device, matching mode, **Keyer = `External`**

Same cables, same ATEM setup. The catch: OBS's DeckLink output sends its **whole program
mix**, so that OBS instance must contain *only* the graphics — if it's also compositing
camera for the stream, the camera goes out the key too.
