import { useEffect, useMemo, useState } from "react";

export default function App() {
  const API = useMemo(
    () => import.meta.env.VITE_API_URL || "http://localhost:3001",
    []
  );

  const [folders, setFolders] = useState([]);
  const [folderId, setFolderId] = useState("");

  // README toggle
  const [showReadme, setShowReadme] = useState(true);

  // Subfolder feature
  const [useSubfolder, setUseSubfolder] = useState(false);
  const [subfolderMode, setSubfolderMode] = useState("existing"); // "existing" | "new"
  const [subfolders, setSubfolders] = useState([]);
  const [subfolderId, setSubfolderId] = useState("");
  const [newSubfolderNumber, setNewSubfolderNumber] = useState("");
  const [subfolderWarning, setSubfolderWarning] = useState("");

  const [file, setFile] = useState(null);
  const [fileNumber, setFileNumber] = useState("");

  const [status, setStatus] = useState("Loading folders...");
  const [busy, setBusy] = useState(false);

  const [duplicateWarning, setDuplicateWarning] = useState(false);

  /* ================= LOAD MAIN FOLDERS ================= */
  useEffect(() => {
    async function load() {
      try {
        setStatus("Loading folders...");
        const res = await fetch(`${API}/api/folders`);
        if (!res.ok) throw new Error(`Failed to load folders (${res.status})`);
        const data = await res.json();

        const list = data.folders || [];
        setFolders(list);
        if (list.length) setFolderId(list[0].id);
        setStatus("Folders loaded.");
      } catch (e) {
        setStatus(`Error loading folders: ${e.message}`);
      }
    }
    load();
  }, [API]);

  function getUploadHeaders() {
    const headers = {};
    const key = import.meta.env.VITE_UPLOAD_KEY;
    if (key) headers["X-Upload-Key"] = key;
    return headers;
  }

  /* ================= LOAD SUBFOLDERS ================= */
  useEffect(() => {
    async function loadSubfolders() {
      if (!useSubfolder || !folderId) return;
      try {
        setSubfolderWarning("");
        const res = await fetch(`${API}/api/subfolders?parentId=${folderId}`);
        if (!res.ok)
          throw new Error(`Failed to load subfolders (${res.status})`);
        const data = await res.json();

        const list = (data.subfolders || []).sort((a, b) =>
          a.name.localeCompare(b.name, undefined, { sensitivity: "base" })
        );

        setSubfolders(list);
        if (subfolderMode === "existing") {
          setSubfolderId(list[0]?.id || "");
        }
      } catch (e) {
        setSubfolderWarning(`Error loading subfolders: ${e.message}`);
      }
    }
    loadSubfolders();
  }, [API, useSubfolder, folderId, subfolderMode]);

  const selectedSubfolderName =
    subfolders.find((f) => f.id === subfolderId)?.name || "";
  const folderNumberX = useSubfolder
    ? subfolderMode === "new"
      ? newSubfolderNumber
      : selectedSubfolderName
    : "";

  const finalNamePreview = computeFinalNamePreview({
    originalName: file?.name,
    useSubfolder,
    folderNumberX,
    fileNumber,
  });

  const canUpload =
    !!file &&
    !!folderId &&
    !busy &&
    (!useSubfolder
      ? isPositiveIntString(fileNumber)
      : (subfolderMode === "existing" && !!subfolderId) ||
        (subfolderMode === "new" && isPositiveIntString(newSubfolderNumber)));

  /* ================= UPLOAD ================= */
  async function uploadFile(confirmDuplicate = false) {
    if (!file) return setStatus("Pick a file first.");
    if (!useSubfolder && !isPositiveIntString(fileNumber))
      return setStatus(
        'Please enter a file number (integer like "1", "2", "3", ...).'
      );

    setBusy(true);
    setStatus("Uploading...");
    setDuplicateWarning(false);
    setSubfolderWarning("");

    try {
      let finalSubfolderId = "";

      if (useSubfolder) {
        if (subfolderMode === "existing") {
          finalSubfolderId = subfolderId;
        } else {
          const res = await fetch(`${API}/api/subfolders`, {
            method: "POST",
            headers: {
              "Content-Type": "application/json",
              ...getUploadHeaders(),
            },
            body: JSON.stringify({
              parentId: folderId,
              name: String(newSubfolderNumber).trim(),
            }),
          });

          const payload = await res.json();

          if (res.status === 409) {
            setSubfolderWarning(payload.error);
            throw new Error(payload.error);
          }

          if (!res.ok)
            throw new Error(payload.error || "Failed to create folder");

          finalSubfolderId = payload.id;
          setStatus(`Subfolder created: ${payload.name}`);
        }
      }

      const form = new FormData();
      form.append("folderId", folderId);
      if (finalSubfolderId) form.append("subfolderId", finalSubfolderId);
      form.append("file", file);
      if (!finalSubfolderId) form.append("fileNumber", String(fileNumber).trim());
      if (confirmDuplicate) form.append("confirmDuplicate", "true");

      const res = await fetch(`${API}/api/upload`, {
        method: "POST",
        body: form,
        headers: getUploadHeaders(),
      });

      const payload = await res.json();

      if (res.status === 409) {
        setDuplicateWarning(true);
        setStatus(payload.message);
        return;
      }

      if (!res.ok) throw new Error(payload.error || "Upload failed");

      setStatus(`Uploaded!\nName: ${payload.name}\nLink: ${payload.webViewLink}`);
    } catch (e) {
      setStatus(`Error: ${e.message}`);
    } finally {
      setBusy(false);
    }
  }

  const statusIsBold = status === "Folders loaded.";

  /* ================= UI ================= */
  return (
    <div style={styles.page}>
      <div style={styles.card}>
        {/* ================= README ================= */}
        <div style={styles.readmeBox}>
          <div
            style={styles.readmeHeader}
            onClick={() => setShowReadme((v) => !v)}
          >
            READ ME {showReadme ? "▲" : "▼"}
          </div>

          {showReadme && (
            <div style={styles.readmeText}>
              <strong>
                This app will be used to upload scunts. Choose one of the four
                folders available. Choose the photo or video you want to upload.
                <br />
                <br />
                If the scunt has multiple photos / videos please upload it in a
                folder:
                <br />
                - Create a folder and upload all related files inside it.
                <br />
                - Folder names must be a single number (X) and must be unique.
                <br />
                - Files inside the folder are named automatically as X.1, X.2,
                X.3, ... (where X is the folder number).
                <br />
                <br />
                If the scunt has only 1 photo / video upload it outside of a
                folder:
                <br />
                - File name must be a single number (X).
                <br />
                - If the same number already exists, you can choose “Upload
                anyway” and it will be saved as X (1), X (2), ...
                <br />
                <br />
                <span style={styles.readmeImportant}>
                  IMPORTANT: Might take some time to connect to the Drive. Wait
                  until available folders appear.
                </span>
              </strong>
            </div>
          )}
        </div>
        {/* =============== END README =============== */}

        <h2 style={styles.title}>Upload to Google Drive</h2>

        <label style={styles.label}>
          Choose main folder:
          <select
            style={styles.input}
            value={folderId}
            onChange={(e) => setFolderId(e.target.value)}
            disabled={busy}
          >
            {folders.map((f) => (
              <option key={f.id} value={f.id}>
                {f.name}
              </option>
            ))}
          </select>
        </label>

        <div style={styles.sectionTitle}>
          <input
            type="checkbox"
            checked={useSubfolder}
            onChange={(e) => setUseSubfolder(e.target.checked)}
          />
          Upload into a subfolder (optional)
        </div>

        {useSubfolder && (
          <div style={styles.subBox}>
            <label style={styles.radio}>
              <input
                type="radio"
                checked={subfolderMode === "existing"}
                onChange={() => setSubfolderMode("existing")}
              />
              <span style={styles.radioText}>Existing subfolder</span>
            </label>

            <label style={styles.radio}>
              <input
                type="radio"
                checked={subfolderMode === "new"}
                onChange={() => setSubfolderMode("new")}
              />
              <span style={styles.radioText}>New subfolder</span>
            </label>

            {subfolderMode === "existing" && (
              <select
                style={styles.input}
                value={subfolderId}
                onChange={(e) => setSubfolderId(e.target.value)}
              >
                {subfolders.map((f) => (
                  <option key={f.id} value={f.id}>
                    {f.name}
                  </option>
                ))}
              </select>
            )}

            {subfolderMode === "new" && (
              <>
                <input
                  style={styles.input}
                  type="number"
                  inputMode="numeric"
                  min={1}
                  placeholder='Folder number (X) e.g. "3"'
                  value={newSubfolderNumber}
                  onChange={(e) => setNewSubfolderNumber(e.target.value)}
                />
                <div style={styles.subtleStrong}>
                  Must be unique (cannot already exist)
                </div>
              </>
            )}

            {subfolderWarning && (
              <div style={styles.warnBox}>{subfolderWarning}</div>
            )}
          </div>
        )}

        <label style={styles.label}>
          Choose file:
          <input
            style={styles.input}
            type="file"
            onChange={(e) => setFile(e.target.files?.[0] || null)}
          />
        </label>

        {!useSubfolder ? (
          <label style={styles.label}>
            File number (X):
            <input
              style={styles.input}
              type="number"
              inputMode="numeric"
              min={1}
              value={fileNumber}
              onChange={(e) => setFileNumber(e.target.value)}
            />
            <div style={styles.subtleStrong}>
              Final name: {finalNamePreview || "—"}
            </div>
          </label>
        ) : (
          <div style={styles.subtleStrong}>
            File name will be auto-assigned as: {finalNamePreview || "—"}
          </div>
        )}

        <button
          style={{
            ...styles.button,
            ...(canUpload ? null : styles.buttonDisabled),
          }}
          onClick={() => uploadFile(false)}
          disabled={!canUpload}
        >
          Upload
        </button>

        {duplicateWarning && (
          <div style={styles.warnBox}>
            File already exists. Upload anyway?
            <br />
            <div style={{ display: "flex", gap: 10, marginTop: 10 }}>
              <button onClick={() => uploadFile(true)} disabled={busy}>
                Upload anyway
              </button>
              <button
                onClick={() => {
                  setDuplicateWarning(false);
                  setStatus("Cancelled.");
                }}
                disabled={busy}
              >
                No
              </button>
            </div>
          </div>
        )}

        <pre style={styles.status}>
          <span style={statusIsBold ? styles.statusBold : undefined}>
            {status}
          </span>
        </pre>

        <div style={styles.hint}>API: {API}</div>
      </div>
    </div>
  );
}

/* ================= HELPERS ================= */
function isPositiveIntString(v) {
  const s = String(v ?? "").trim();
  return /^\d+$/.test(s) && Number(s) >= 1;
}

function computeFinalNamePreview({
  originalName,
  useSubfolder,
  folderNumberX,
  fileNumber,
}) {
  if (!originalName) return "";

  const ext = originalName.includes(".")
    ? originalName.slice(originalName.lastIndexOf("."))
    : "";

  if (useSubfolder) {
    if (!isPositiveIntString(folderNumberX)) return "";
    const X = String(Number(String(folderNumberX).trim()));
    return `${X}.Y${ext}`;
  }

  if (!isPositiveIntString(fileNumber)) return "";
  const X = String(Number(String(fileNumber).trim()));
  return `${X}${ext}`;
}

/* ================= STYLES ================= */
const styles = {
  page: {
    fontFamily: "Arial, sans-serif",
    maxWidth: 720,
    margin: "40px auto",
    padding: 16,
  },
  card: {
    border: "1px solid #ccc",
    borderRadius: 14,
    padding: 20,
    background: "#fff",
  },
  title: { fontWeight: 900 },

  // README styles
  readmeBox: {
    border: "3px solid #000",
    borderRadius: 14,
    padding: 14,
    marginBottom: 20,
    background: "#f9f9f9",
  },
  readmeHeader: {
    fontWeight: 900,
    fontSize: 38,
    letterSpacing: 2,
    cursor: "pointer",
    userSelect: "none",
    color: "#000",         // ⬅ FORCE BLACK
    WebkitTextFillColor: "#000",
  },  
  readmeText: {
    marginTop: 14,
    fontSize: 14,
    lineHeight: 1.5,
    color: "#000",
  },
  readmeImportant: {
    color: "red",
    fontWeight: 900,
  },

  label: { fontWeight: 900, marginTop: 16, display: "block", color: "#000" },
  input: { width: "100%", padding: 10, marginTop: 6 },

  sectionTitle: {
    marginTop: 18,
    fontWeight: 900,
    fontSize: 15,
    color: "#000",
    display: "flex",
    gap: 8,
    alignItems: "center",
  },

  subBox: {
    marginTop: 10,
    padding: 14,
    border: "2px solid #000",
    borderRadius: 10,
  },

  radio: {
    display: "flex",
    alignItems: "center",
    gap: 10,
    marginTop: 10,
  },
  radioText: {
    fontWeight: 900,
    fontSize: 15,
    color: "#000",
  },

  subtleStrong: {
    fontWeight: 800,
    fontSize: 13,
    marginTop: 6,
    color: "#000",
  },

  button: {
    marginTop: 20,
    padding: "12px 18px",
    fontWeight: 900,
    cursor: "pointer",
  },
  buttonDisabled: { opacity: 0.5 },

  status: {
    marginTop: 16,
    padding: 12,
    border: "2px solid #000",
    color: "#000",
  },
  statusBold: { fontWeight: 900 },

  warnBox: {
    marginTop: 12,
    padding: 12,
    border: "2px solid red",
    fontWeight: 900,
    color: "#000",
  },

  hint: { marginTop: 10, fontWeight: 700 },
};
