import fs from "fs";
import path from "path";
import { fileURLToPath } from "url";
import QRCode from "qrcode";
import dotenv from "dotenv";
import { hashQRIdentifier, hashCommonCVIdentifier } from "../utils/qrHash.js";

// ============================================================
// ENVIRONMENT
// ============================================================

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);

// Load backend/.env
const backendEnvPath = path.resolve(__dirname, "../.env");

if (fs.existsSync(backendEnvPath)) {
  dotenv.config({ path: backendEnvPath });
} else {
  dotenv.config();
}

// IMPORTANT:
// Physical QR codes MUST link to the production Vercel frontend URL,
// NOT Render backend API or localhost.
// Configurable via QR_BASE_URL in .env.
let rawBase = (
  process.env.QR_BASE_URL ||
  process.env.FRONTEND_URL ||
  "https://participant-xtract-5-0.vercel.app"
).trim().replace(/\/+$/, "");

// Clean accidental duplicate schemes like https://https:// or http://http://
rawBase = rawBase.replace(/^(https?:\/\/)+/, (match) => {
  return match.includes("https://") ? "https://" : "http://";
});

const QR_BASE_URL = rawBase;

// ============================================================
// CANONICAL TRACKS / STAGES
// ============================================================

// Track 1: DESERT (formerly Harvest)
// Track 2: FOREST
// Track 3: VOLCANIC (formerly Autumn)
// Track 4: ARCTIC (formerly Winter)
const TRACKS = ["DESERT", "FOREST", "VOLCANIC", "ARCTIC"];
const TRACK_STAGES = ["DS", "ML", "NLP"];

// ============================================================
// OUTPUT DIRECTORIES
// ============================================================

// Project root:
// Xtract_participant/qr-codes/
const ROOT_OUTPUT_DIR = path.resolve(__dirname, "../../qr-codes");

// Backend:
// Xtract_participant/backend/qr-codes/
const BACKEND_OUTPUT_DIR = path.resolve(__dirname, "../qr-codes");

// Create directories if they don't exist
for (const dir of [ROOT_OUTPUT_DIR, BACKEND_OUTPUT_DIR]) {
  if (!fs.existsSync(dir)) {
    fs.mkdirSync(dir, { recursive: true });
  }
}

// ============================================================
// QR GENERATION
// ============================================================

async function generateAllQRs() {
  console.log("");
  console.log("====================================================");
  console.log("        XTRACT 5.0 — PHYSICAL QR GENERATOR");
  console.log("====================================================");
  console.log("");
  console.log(`Base URL: ${QR_BASE_URL}`);
  console.log("");
  console.log(`Root Output:    ${ROOT_OUTPUT_DIR}`);
  console.log(`Backend Output: ${BACKEND_OUTPUT_DIR}`);
  console.log("");

  // Remove legacy track files (Autumn, Harvest, Winter) so only Desert, Forest, Volcanic, and Arctic remain
  const legacyTracksToClean = ["AUTUMN", "HARVEST", "VOLCANINC", "WINTER"];
  for (const outputDir of [ROOT_OUTPUT_DIR, BACKEND_OUTPUT_DIR]) {
    for (const track of legacyTracksToClean) {
      for (const stage of ["DS", "ML", "NLP", "CV"]) {
        for (const ext of ["png", "svg"]) {
          const oldFile = path.join(outputDir, `QR-${track}-${stage}.${ext}`);
          if (fs.existsSync(oldFile)) {
            try { fs.unlinkSync(oldFile); } catch (e) {}
          }
        }
      }
    }
  }

  const manifest = [];
  let count = 0;

  const pngOptions = {
    errorCorrectionLevel: "H",
    type: "png",
    quality: 0.95,
    margin: 2,
    width: 1024,
    color: {
      dark: "#000000",
      light: "#ffffff",
    },
  };

  const svgOptions = {
    errorCorrectionLevel: "H",
    type: "svg",
    margin: 2,
    color: {
      dark: "#000000",
      light: "#ffffff",
    },
  };

  // ----------------------------------------------------------
  // 1. Generate 4 Tracks × 3 Stages (DS, ML, NLP) = 12 QR codes
  // ----------------------------------------------------------

  for (const track of TRACKS) {
    for (const stage of TRACK_STAGES) {
      count++;

      const qrIdentifier = `QR-${track}-${stage}`;
      const qrHash = hashQRIdentifier(track, stage);
      const targetUrl = `${QR_BASE_URL}/qr/${qrHash}`;

      const pngFilename = `${qrIdentifier}.png`;
      const svgFilename = `${qrIdentifier}.svg`;

      for (const outputDir of [ROOT_OUTPUT_DIR, BACKEND_OUTPUT_DIR]) {
        const pngPath = path.join(outputDir, pngFilename);
        const svgPath = path.join(outputDir, svgFilename);

        await QRCode.toFile(pngPath, targetUrl, pngOptions);
        await QRCode.toFile(svgPath, targetUrl, svgOptions);
      }

      console.log(`[${String(count).padStart(2, "0")}/13] ${qrIdentifier} [${qrHash}]`);
      console.log(`       ${targetUrl}`);

      manifest.push({
        index: count,
        track,
        stage,
        identifier: qrIdentifier,
        hash: qrHash,
        url: targetUrl,
        png: pngFilename,
        svg: svgFilename,
      });
    }
  }

  // ----------------------------------------------------------
  // 2. Generate 1 Unified Stage 4 (CV) QR code for all tracks
  // ----------------------------------------------------------

  count++;
  const cvIdentifier = "QR-CV";
  const cvHash = hashCommonCVIdentifier();
  const cvTargetUrl = `${QR_BASE_URL}/qr/${cvHash}`;
  const cvPngFilename = `${cvIdentifier}.png`;
  const cvSvgFilename = `${cvIdentifier}.svg`;

  for (const outputDir of [ROOT_OUTPUT_DIR, BACKEND_OUTPUT_DIR]) {
    const pngPath = path.join(outputDir, cvPngFilename);
    const svgPath = path.join(outputDir, cvSvgFilename);

    await QRCode.toFile(pngPath, cvTargetUrl, pngOptions);
    await QRCode.toFile(svgPath, cvTargetUrl, svgOptions);
  }

  console.log(`[${String(count).padStart(2, "0")}/13] ${cvIdentifier} [${cvHash}] (Common for all tracks)`);
  console.log(`       ${cvTargetUrl}`);

  manifest.push({
    index: count,
    track: "ALL",
    stage: "CV",
    identifier: cvIdentifier,
    hash: cvHash,
    url: cvTargetUrl,
    png: cvPngFilename,
    svg: cvSvgFilename,
  });

  // ==========================================================
  // JSON MANIFEST
  // ==========================================================

  const manifestJsonPath = path.join(ROOT_OUTPUT_DIR, "manifest.json");

  fs.writeFileSync(
    manifestJsonPath,
    JSON.stringify(
      {
        baseUrl: QR_BASE_URL,
        generatedAt: new Date().toISOString(),
        total: manifest.length,
        codes: manifest,
      },
      null,
      2,
    ),
  );

  // ==========================================================
  // MARKDOWN GUIDE
  // ==========================================================

  const manifestMdPath = path.join(ROOT_OUTPUT_DIR, "README.md");

  const tableRows = manifest
    .map(
      (qr) =>
        `| ${qr.index} | **\`${qr.identifier}\`** | ${qr.track} | ${qr.stage} | \`${qr.url}\` | [PNG](./${qr.png}) • [SVG](./${qr.svg}) |`,
    )
    .join("\n");

  const mdContent = `# Xtract 5.0 — Physical Checkpoint QR Codes

Generated on: ${new Date().toISOString()}

Base Landing URL:

\`${QR_BASE_URL}\`

Total Checkpoints:

**13 — 4 Tracks × 3 Stages (DS, ML, NLP) + 1 Common Stage 4 (CV)**

---

## Checkpoint Registry

| # | Checkpoint | Track | Stage | Mobile Landing URL | Files |
|---|---|---|---|---|---|
${tableRows}

---

## Venue Placement Guidelines

1. Print the **SVG** or high-resolution **PNG**.
2. Place each QR at its designated physical checkpoint.
3. Stages 1–3 (DS, ML, NLP) are track-specific checkpoints.
4. Stage 4 (CV) is a single, common checkpoint placed in the venue for all teams.
5. Participants scan using Google Lens or their phone camera.
6. The QR opens the public landing page on Vercel.
7. The participant logs in using their Team ID and password.
8. Backend validates the authenticated team and stage progression.
9. Successful redemption emits a Socket.IO event to that team's workstation.
10. The workstation unlocks the answer input. No answer/password is sent to the phone.

---

## Network Requirement

The QR codes use the Vercel Frontend domain:

\`${QR_BASE_URL}\`

Do NOT replace with Render API URL or localhost for physical QR codes.

---

## QR Identifiers

${manifest.map((qr) => `- \`${qr.identifier}\` → ${qr.url}`).join("\n")}
`;

  fs.writeFileSync(manifestMdPath, mdContent);

  // ==========================================================
  // FINISHED
  // ==========================================================

  console.log("");
  console.log("====================================================");
  console.log(`✓ Successfully generated all ${manifest.length} QR checkpoints`);
  console.log("✓ PNG + SVG generated (including unified QR-CV)");
  console.log(`✓ JSON manifest: ${manifestJsonPath}`);
  console.log(`✓ README: ${manifestMdPath}`);
  console.log(`✓ Base URL: ${QR_BASE_URL}`);
  console.log("====================================================");
  console.log("");
}

// ============================================================
// ERROR HANDLING
// ============================================================

generateAllQRs().catch((error) => {
  console.error("");
  console.error("❌ Failed to generate QR codes:");
  console.error(error);
  console.error("");
  process.exit(1);
});
