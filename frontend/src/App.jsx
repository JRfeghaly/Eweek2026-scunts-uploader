import { useEffect, useMemo, useState } from "react";

export default function App() {
  const API = useMemo(
    () => import.meta.env.VITE_API_URL || "http://localhost:3001",
    []
  );

  const [folders, setFolders] = useState([]);
  const [folderId, setFolderId] = useState("");
  const [file, setFile] = useState(null);

  // REQUIRED
  const [desiredName, setDesiredName] = useState("");

  const [status, setStatus] = useState("Loading folders...");
  const [busy, setBusy] = useState(false);

  // NEW: duplicate warning UX
  const [duplicateWarning, setDuplicateWarning] = useState(false);

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

  const finalNamePreview = computeFinalNamePreview(file?.name, desiredName);
  const canUpload =
    !!file && !!folderId && desiredName.trim().length > 0 && !busy;

  async function upload(confirmDuplicate = false) {
    if (!file) return setStatus("Pick a file first.");
    if (!folderId) return setStatus("Pick a folder first.");
    if (!desiredName.trim())
      return setStatus("Please enter a file name before uploading.");

    setBusy(true);
    setStatus("Uploading...");
    // reset warning on every attempt
    setDuplicateWarning(false);

    try {
      const form = new FormData();
      form.append("folderId", folderId);
      form.append("file", file);
      form.append("desiredName", desiredName.trim());
      if (confirmDuplicate) form.append("confirmDuplicate", "true");

      const res = await fetch(`${API}/api/upload`, {
        method: "POST",
        body: form,
        headers: getUploadHeaders(),
      });

      // Read response safely (JSON if possible, otherwise text)
      const contentType = res.headers.get("content-type") || "";
      const payload = contentType.includes("application/json")
        ? await res.json()
        : { raw: await res.text() };

      // Duplicate detected → show warning UI instead of failing
      if (res.status === 409) {
        setDuplicateWarning(true);
        setStatus(
          payload?.message ||
            `A file named "${finalNamePreview}" already exists.`
        );
        return;
      }

      // Other errors → show useful message
      if (!res.ok) {
        const msg =
          payload?.error ||
          payload?.message ||
          payload?.raw ||
          `Upload failed (${res.status})`;
        throw new Error(msg);
      }

      setStatus(`Uploaded!\nName: ${payload.name}\nLink: ${payload.webViewLink}`);
    } catch (e) {
      setStatus(`Error: ${e.message}`);
    } finally {
      setBusy(false);
    }
  }

  return (
    <div style={styles.page}>
      <div style={styles.card}>
        <h2 style={{ marginTop: 0 }}>Upload to Google Drive</h2>

        <label style={styles.label}>
          Choose folder:
          <select
            style={styles.input}
            value={folderId}
            onChange={(e) => {
              setFolderId(e.target.value);
              setDuplicateWarning(false);
            }}
            disabled={busy}
          >
            {folders.map((f) => (
              <option key={f.id} value={f.id}>
                {f.name}
              </option>
            ))}
          </select>
        </label>

        <label style={styles.label}>
          Choose file:
          <input
            style={styles.input}
            type="file"
            onChange={(e) => {
              const picked = e.target.files?.[0] || null;
              setFile(picked);
              setDuplicateWarning(false);

              if (picked) setStatus("File selected. Please enter a name.");
              else setStatus("Pick a file first.");
            }}
            disabled={busy}
          />
        </label>

        <label style={styles.label}>
          Name on Drive (required):
          <input
            style={styles.input}
            value={desiredName}
            onChange={(e) => {
              setDesiredName(e.target.value);
              setDuplicateWarning(false);
            }}
            placeholder="e.g. team3_scunt_video"
            disabled={busy || !file}
          />

          <div style={styles.subtle}>
            Requested name:{" "}
            <code>{finalNamePreview || "(pick a file first)"}</code>
          </div>

          {file && !desiredName.trim() && (
            <div style={styles.warn}>
              Please enter a file name before uploading.
            </div>
          )}
        </label>

        <button
          style={{
            ...styles.button,
            ...(canUpload ? null : styles.buttonDisabled),
          }}
          onClick={() => upload(false)}
          disabled={!canUpload}
        >
          {busy ? "Uploading..." : "Upload"}
        </button>

        {/* Duplicate warning UI */}
        {duplicateWarning && (
          <div style={styles.warnBox}>
            <div style={{ fontWeight: 700, marginBottom: 6 }}>
              Duplicate name
            </div>
            <div style={{ marginBottom: 10 }}>
              A file named <code>{finalNamePreview}</code> already exists in this
              folder.
              <br />
              Uploading anyway will save as <code>name (2)</code>,{" "}
              <code>name (3)</code>, etc.
            </div>

            <div style={{ display: "flex", gap: 10, flexWrap: "wrap" }}>
              <button
                style={styles.button}
                onClick={() => upload(true)}
                disabled={busy}
              >
                Upload anyway
              </button>

              <button
                style={styles.secondaryBtn}
                onClick={() => {
                  setDuplicateWarning(false);
                  setStatus("Upload cancelled.");
                }}
                disabled={busy}
              >
                Cancel
              </button>
            </div>
          </div>
        )}

        <pre style={styles.status}>
          <span style={status === "Folders loaded." ? styles.statusBold : undefined}>
            {status}
          </span>
        </pre>


        <div style={styles.hint}>
          API: <code>{API}</code>
        </div>
      </div>
    </div>
  );
}

function computeFinalNamePreview(originalName, desiredName) {
  if (!originalName) return "";
  const desired = (desiredName || "").trim();
  if (!desired) return originalName;

  const originalExt = getExt(originalName);
  const desiredExt = getExt(desired);

  if (desiredExt) return desired;
  return desired + originalExt;
}

function getExt(name) {
  const i = name.lastIndexOf(".");
  if (i <= 0) return "";
  return name.slice(i);
}

const styles = {
  page: {
    fontFamily: "Arial, sans-serif",
    maxWidth: 720,
    margin: "40px auto",
    padding: 16,
  },
  card: {
    border: "1px solid #eee",
    borderRadius: 12,
    padding: 18,
    boxShadow: "0 2px 10px rgba(0,0,0,0.05)",
  },
  statusBold: {
    fontWeight: 800,
  },  
  label: { display: "block", marginTop: 14, fontWeight: 600 },
  input: { display: "block", width: "100%", marginTop: 8, padding: 10 },

  button: {
    marginTop: 18,
    padding: "10px 16px",
    cursor: "pointer",
    borderRadius: 10,
    border: "1px solid #ddd",
    background: "white",
  },
  buttonDisabled: {
    opacity: 0.55,
    cursor: "not-allowed",
  },

  secondaryBtn: {
    marginTop: 18,
    padding: "10px 16px",
    borderRadius: 10,
    border: "1px solid #ddd",
    background: "#f9f9f9",
    cursor: "pointer",
  },

  status: {
    marginTop: 16,
    background: "#fafafa",
    padding: 12,
    borderRadius: 10,
    whiteSpace: "pre-wrap",
    border: "1px solid #eee",
    color: "#111",
  },

  hint: { marginTop: 12, fontSize: 12, opacity: 0.7 },
  subtle: { marginTop: 8, fontSize: 12, opacity: 0.75 },

  warn: {
    marginTop: 8,
    padding: "8px 10px",
    borderRadius: 10,
    border: "1px solid #f0d28a",
    background: "#fff8e1",
    fontSize: 12,
    lineHeight: 1.3,
  },

  warnBox: {
    marginTop: 14,
    padding: 14,
    borderRadius: 12,
    border: "1px solid #f0c36d",
    background: "#fff8e1",
  },
};