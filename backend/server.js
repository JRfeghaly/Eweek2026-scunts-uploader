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
    const ok =
      file.mimetype.startsWith("image/") || file.mimetype.startsWith("video/");
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

function isPositiveIntString(v) {
  const s = String(v ?? "").trim();
  // Integer chosen by user; treat as positive integer (1, 2, 3, ...)
  return /^\d+$/.test(s) && Number(s) >= 1;
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

async function listAllFilesInFolder(folderId) {
  const q = [`'${folderId}' in parents`, "trashed = false"].join(" and ");

  let pageToken;
  const out = [];
  do {
    const resp = await drive.files.list({
      q,
      fields: "nextPageToken, files(id,name)",
      pageSize: 1000,
      pageToken,
      supportsAllDrives: true,
      includeItemsFromAllDrives: true,
    });

    out.push(...(resp.data.files || []));
    pageToken = resp.data.nextPageToken;
  } while (pageToken);

  return out;
}

async function getDriveFileInfo(fileId) {
  const resp = await drive.files.get({
    fileId,
    fields: "id,name,mimeType",
    supportsAllDrives: true,
  });
  return resp.data;
}

// Create subfolder; block if name exists
async function createSubfolder(parentId, nameRaw) {
  const name = sanitizeBaseName(nameRaw);
  if (!name) throw new Error("Subfolder name is required.");
  if (!isPositiveIntString(name)) {
    throw new Error('Folder name must be an integer like "1", "2", "3", ...');
  }

  const existing = await listSubfolders(parentId);
  const dup = existing.find((f) => (f.name || "").toLowerCase() === name.toLowerCase());
  if (dup) {
    const err = new Error(`A folder named "${name}" already exists.`);
    err.code = "DUP_FOLDER";
    err.existingId = dup.id;
    throw err;
  }

  const created = await drive.files.create({
    requestBody: {
      name,
      mimeType: "application/vnd.google-apps.folder",
      parents: [parentId],
    },
    fields: "id,name",
    supportsAllDrives: true,
  });

  return created.data; // {id,name}
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

// List subfolders of a chosen main folder
// GET /api/subfolders?parentId=...
app.get("/api/subfolders", async (req, res) => {
  try {
    const parentId = req.query.parentId;
    if (!parentId) return res.status(400).json({ error: "Missing parentId" });

    const subfolders = await listSubfolders(parentId);
    res.json({ parentId, subfolders });
  } catch (e) {
    res.status(500).json({ error: e.message });
  }
});

// Create subfolder under a chosen main folder
// POST /api/subfolders  { parentId, name }
app.post("/api/subfolders", requireUploadKey, async (req, res) => {
  try {
    const { parentId, name } = req.body || {};
    if (!parentId) return res.status(400).json({ error: "Missing parentId" });
    if (!name || !String(name).trim())
      return res.status(400).json({ error: "Subfolder name is required." });

    const folder = await createSubfolder(parentId, name);
    res.json(folder);
  } catch (e) {
    if (e.code === "DUP_FOLDER") {
      return res.status(409).json({
        error: e.message,
        existingId: e.existingId,
      });
    }
    res.status(500).json({ error: e.message });
  }
});

// Upload:
// folderId (required) = main folder
// subfolderId (optional) = if provided, upload INTO this folder instead
// desiredName (required)
// confirmDuplicate optional
app.post(
  "/api/upload",
  requireUploadKey,
  upload.single("file"),
  async (req, res) => {
    const {
      folderId,
      subfolderId = "",
      fileNumber = "",
      confirmDuplicate,
    } = req.body;

    const file = req.file;

    if (!file) return res.status(400).json({ error: "No file uploaded" });

    if (!folderId) {
      safeUnlink(file.path);
      return res.status(400).json({ error: "Missing folderId" });
    }

    // If subfolderId was provided, that's the real destination
    const targetFolderId = subfolderId?.trim() ? subfolderId.trim() : folderId;

    const originalExt = path.extname(file.originalname) || "";

    try {
      // Naming rules:
      // - Uploading outside a subfolder: name is X (integer provided by user)
      // - Uploading inside a subfolder named X: name is X.Y (Y auto-increments from 1)
      const files = await listAllFilesInFolder(targetFolderId);
      const existingBases = new Set(
        files
          .map((f) => (f.name ? path.basename(f.name) : ""))
          .filter(Boolean)
          .map((name) => {
            const ext = path.extname(name);
            return name.slice(0, name.length - ext.length); // base without extension
          })
      );

      let baseToUse = "";

      // CASE A: inside subfolder => X.Y (auto)
      if (subfolderId?.trim()) {
        const folderInfo = await getDriveFileInfo(subfolderId.trim());
        if (folderInfo.mimeType !== "application/vnd.google-apps.folder") {
          throw new Error("subfolderId is not a folder.");
        }

        const folderName = sanitizeBaseName(folderInfo.name);
        if (!isPositiveIntString(folderName)) {
          throw new Error(
            `Selected folder name must be an integer like "1", "2", "3". Found: "${folderInfo.name}"`
          );
        }

        const X = String(Number(folderName));
        // Find the next Y such that base "X.Y" doesn't already exist (regardless of extension)
        let maxY = 0;
        const re = new RegExp(`^${X}\\.(\\d+)$`);
        for (const b of existingBases) {
          const m = String(b).match(re);
          if (!m) continue;
          const y = Number(m[1]);
          if (Number.isFinite(y) && y > maxY) maxY = y;
        }

        let y = maxY + 1;
        // Defensive: ensure truly free in case of weird existing names
        while (existingBases.has(`${X}.${y}`)) y++;
        baseToUse = `${X}.${y}`;
      }

      // CASE B: outside subfolder => X (user-chosen)
      else {
        if (!isPositiveIntString(fileNumber)) {
          safeUnlink(file.path);
          return res
            .status(400)
            .json({ error: 'File number is required (integer like "1", "2", "3", ...)'});
        }

        const chosen = String(Number(String(fileNumber).trim()));
        const taken = existingBases.has(chosen);

        // Duplicate naming (outside subfolder): X, X (1), X (2), ...
        function nextDuplicateBase(X) {
          let n = 1;
          while (existingBases.has(`${X} (${n})`)) n++;
          return `${X} (${n})`;
        }

        if (taken && confirmDuplicate !== "true") {
          const suggested = nextDuplicateBase(chosen);

          safeUnlink(file.path);
          return res.status(409).json({
            message: `A file numbered "${chosen}" already exists. Upload anyway to save as "${suggested}${originalExt}".`,
            warning: true,
          });
        }

        // If the chosen X is free, keep it. Otherwise (confirmed), save as X (n)
        baseToUse = taken ? nextDuplicateBase(chosen) : chosen;
      }

      const finalName = `${baseToUse}${originalExt}`;

      const created = await drive.files.create({
        requestBody: { name: finalName, parents: [targetFolderId] },
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
  }
);

// Multer errors
app.use((err, req, res, next) => {
  if (err?.code === "LIMIT_FILE_SIZE") {
    return res
      .status(413)
      .json({ error: `File too large. Max is ${MAX_FILE_SIZE_MB} MB` });
  }
  return res.status(400).json({ error: err?.message || "Bad request" });
});

app.listen(PORT, () => {
  console.log(`Backend running on http://localhost:${PORT}`);
});