import "dotenv/config";
import express from "express";
import multer from "multer";
import cors from "cors";
import fs from "fs";
import path from "path";
import { google } from "googleapis";

const app = express();
app.use(express.json());

// ===== ENV CONFIG =====
const PORT = process.env.PORT || 3001;
const ROOT_FOLDER_ID = process.env.ROOT_FOLDER_ID;
const UPLOAD_KEY = process.env.UPLOAD_KEY; // header "X-Upload-Key"
const FRONTEND_ORIGIN = process.env.FRONTEND_ORIGIN;

const MAX_FILE_SIZE_MB = Number(process.env.MAX_FILE_SIZE_MB || "300");
const MAX_FILE_SIZE_BYTES = MAX_FILE_SIZE_MB * 1024 * 1024;

const TMP_DIR = process.env.TMP_DIR || "tmp";
if (!fs.existsSync(TMP_DIR)) fs.mkdirSync(TMP_DIR, { recursive: true });

// CORS
app.use(
  cors(
    FRONTEND_ORIGIN
      ? {
          origin: FRONTEND_ORIGIN,
          methods: ["GET", "POST"],
          allowedHeaders: ["Content-Type", "X-Upload-Key"],
        }
      : undefined
  )
);

if (!ROOT_FOLDER_ID) throw new Error("Missing ROOT_FOLDER_ID env var.");

// ===== GOOGLE DRIVE AUTH =====
let auth;
if (process.env.GOOGLE_SERVICE_ACCOUNT_JSON) {
  const creds = JSON.parse(process.env.GOOGLE_SERVICE_ACCOUNT_JSON);
  auth = new google.auth.GoogleAuth({
    credentials: creds,
    scopes: ["https://www.googleapis.com/auth/drive"],
  });
} else {
  auth = new google.auth.GoogleAuth({
    keyFile: "./service-account.json",
    scopes: ["https://www.googleapis.com/auth/drive"],
  });
}
const drive = google.drive({ version: "v3", auth });

// ===== MULTER =====
const upload = multer({
  dest: TMP_DIR,
  limits: { fileSize: MAX_FILE_SIZE_BYTES },
  fileFilter: (req, file, cb) => {
    const ok = file.mimetype.startsWith("image/") || file.mimetype.startsWith("video/");
    if (!ok) return cb(new Error(`Unsupported file type: ${file.mimetype}`));
    cb(null, true);
  },
});

// ===== AUTH MIDDLEWARE =====
function requireUploadKey(req, res, next) {
  if (!UPLOAD_KEY) return next();
  const key = req.header("X-Upload-Key");
  if (key !== UPLOAD_KEY) return res.status(401).json({ error: "Unauthorized" });
  next();
}

// ===== HELPERS =====
function safeUnlink(p) {
  try {
    if (p && fs.existsSync(p)) fs.unlinkSync(p);
  } catch {}
}

function sanitizeBaseName(name) {
  // remove slashes and reserved characters
  return String(name || "").replace(/[\/\\:*?"<>|]/g, "").trim();
}

function getFinalName(originalName, desiredNameRaw) {
  const desired = sanitizeBaseName(desiredNameRaw || "");
  if (!desired) return originalName;

  const originalExt = path.extname(originalName); // ".jpg"
  const desiredExt = path.extname(desired);

  // If user included extension, keep it; otherwise append original extension
  return desiredExt ? desired : desired + originalExt;
}

async function listSubfolders(parentId) {
  const q = [
    `'${parentId}' in parents`,
    "mimeType = 'application/vnd.google-apps.folder'",
    "trashed = false",
  ].join(" and ");

  const resp = await drive.files.list({
    q,
    fields: "files(id,name)",
    pageSize: 200,
    supportsAllDrives: true,
    includeItemsFromAllDrives: true,
  });

  return resp.data.files || [];
}

function escapeForDriveQuery(str) {
  return String(str).replace(/'/g, "\\'");
}

// Fetch potential duplicates (we filter precisely in code)
async function listPotentialDuplicateNames(folderId, base) {
  const safeBase = escapeForDriveQuery(base);

  const q = [
    `'${folderId}' in parents`,
    `name contains '${safeBase}'`,
    "trashed = false",
  ].join(" and ");

  const resp = await drive.files.list({
    q,
    fields: "files(id,name)",
    pageSize: 200,
    supportsAllDrives: true,
    includeItemsFromAllDrives: true,
  });

  return resp.data.files || [];
}

function escapeRegex(s) {
  return String(s).replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
}

// Decide the next available name: base.ext, base (2).ext, base (3).ext ...
async function resolveUniqueName(folderId, desiredFullName) {
  const ext = path.extname(desiredFullName);              // ".mp4" or ""
  const base = desiredFullName.slice(0, desiredFullName.length - ext.length); // "abc" or "abc (2)"

  // We want numbering applied to the *base* without any trailing " (n)".
  // If user typed "abc (2)", treat "abc" as the root base.
  const m = base.match(/^(.*) \((\d+)\)$/);
  const rootBase = m ? m[1] : base;

  // Get all candidates containing rootBase, then filter precisely:
  // rootBase + ext
  // rootBase (n) + ext  (n>=2)
  const files = await listPotentialDuplicateNames(folderId, rootBase);

  const re = new RegExp(
    `^${escapeRegex(rootBase)}(?: \\((\\d+)\\))?${escapeRegex(ext)}$`
  );

  let maxIndex = 1; // 1 corresponds to "rootBase.ext" (no suffix)
  let exactTaken = false;

  for (const f of files) {
    const name = f.name || "";
    const match = name.match(re);
    if (!match) continue;

    const numStr = match[1];
    if (!numStr) {
      exactTaken = true;
      continue;
    }
    const n = Number(numStr);
    if (Number.isFinite(n) && n >= 2) {
      if (n > maxIndex) maxIndex = n;
    }
  }

  // If exact name isn't taken, use it as-is (rootBase.ext)
  const canonical = rootBase + ext;
  if (!exactTaken && (m ? (base + ext) === canonical : true)) {
    // If user typed "abc", we return "abc.ext".
    // If user typed "abc (2)" and "abc.ext" isn't taken, we still prefer "abc.ext".
    return canonical;
  }

  // Otherwise next is maxIndex+1 (starting at 2)
  const next = maxIndex + 1;
  return `${rootBase} (${next})${ext}`;
}

// ===== ROUTES =====
app.get("/", (req, res) => {
  res.send("Backend is running. Use GET /api/folders and POST /api/upload");
});

app.get("/api/folders", async (req, res) => {
  try {
    const folders = await listSubfolders(ROOT_FOLDER_ID);
    res.json({ rootFolderId: ROOT_FOLDER_ID, folders });
  } catch (e) {
    res.status(500).json({ error: e.message });
  }
});

// form-data fields: folderId, desiredName (REQUIRED), file=@...
// form-data fields:
// folderId (required)
// desiredName (required)
// confirmDuplicate = "true" (optional)
// file=@...

app.post("/api/upload", requireUploadKey, upload.single("file"), async (req, res) => {
  const { folderId, desiredName = "", confirmDuplicate } = req.body;
  const file = req.file;

  if (!file) return res.status(400).json({ error: "No file uploaded" });

  if (!desiredName || !desiredName.trim()) {
    safeUnlink(file.path);
    return res.status(400).json({ error: "File name is required." });
  }

  if (!folderId) {
    safeUnlink(file.path);
    return res.status(400).json({ error: "Missing folderId" });
  }

  const requestedName = getFinalName(file.originalname, desiredName);

  try {
    // Step 1: check if base name already exists
    const ext = path.extname(requestedName);
    const base = requestedName.slice(0, requestedName.length - ext.length);

    const existing = await listPotentialDuplicateNames(folderId, base);

    const exactMatch = existing.some(
      (f) => f.name === requestedName
    );

    // If exists and not confirmed → warn
    if (exactMatch && confirmDuplicate !== "true") {
      safeUnlink(file.path);
      return res.status(409).json({
        message: `A file named "${requestedName}" already exists.`,
        warning: true,
      });
    }

    // Step 2: resolve unique indexed name
    const finalName = await resolveUniqueName(folderId, requestedName);

    const created = await drive.files.create({
      requestBody: { name: finalName, parents: [folderId] },
      media: { mimeType: file.mimetype, body: fs.createReadStream(file.path) },
      fields: "id,name,webViewLink",
      supportsAllDrives: true,
    });

    safeUnlink(file.path);
    res.json(created.data);
  } catch (e) {
    safeUnlink(file.path);
    res.status(500).json({ error: e.message });
  }
});

// Multer errors
app.use((err, req, res, next) => {
  if (err?.code === "LIMIT_FILE_SIZE") {
    return res.status(413).json({ error: `File too large. Max is ${MAX_FILE_SIZE_MB} MB` });
  }
  return res.status(400).json({ error: err?.message || "Bad request" });
});

app.listen(PORT, () => {
  console.log(`Backend running on http://localhost:${PORT}`);
});
