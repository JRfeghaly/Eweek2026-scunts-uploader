import { useEffect, useMemo, useState } from "react";

export default function App() {
  const API = useMemo(
    () => import.meta.env.VITE_API_URL || "http://localhost:3001",
    []
  );

  const [folders, setFolders] = useState([]);
  const [folderId, setFolderId] = useState("");

  // Subfolder feature
  const [useSubfolder, setUseSubfolder] = useState(false);
  const [subfolderMode, setSubfolderMode] = useState("existing"); // "existing" | "new"
  const [subfolders, setSubfolders] = useState([]);
  const [subfolderId, setSubfolderId] = useState("");
  const [newSubfolderName, setNewSubfolderName] = useState("");
  const [subfolderWarning, setSubfolderWarning] = useState("");

  const [file, setFile] = useState(null);

  // REQUIRED
  const [desiredName, setDesiredName] = useState("");

  const [status, setStatus] = useState("Loading folders...");
  const [busy, setBusy] = useState(false);

  // Duplicate warning UX (files)
  const [duplicateWarning, setDuplicateWarning] = useState(false);

  // Load main folders
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

  // Load subfolders whenever:
  // - useSubfolder enabled
  // - folderId changes
  useEffect(() => {
    async function loadSubfolders() {
      if (!useSubfolder || !folderId) return;
      try {
        setSubfolderWarning("");
        const res = await fetch(`${API}/api/subfolders?parentId=${folderId}`);
        if (!res.ok)
          throw new Error(`Failed to load subfolders (${res.status})`);
        const data = await res.json();

        const list = (data.subfolders || []).slice();
        // alphabetical
        list.sort((a, b) =>
          String(a.name || "").localeCompare(String(b.name || ""), undefined, {
            sensitivity: "base",
          })
        );

        setSubfolders(list);
        // Default-select first subfolder if existing mode
        if (subfolderMode === "existing") {
          setSubfolderId(list[0]?.id || "");
        }
      } catch (e) {
        setSubfolderWarning(`Error loading subfolders: ${e.message}`);
      }
    }
    loadSubfolders();
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [API, useSubfolder, folderId]);

  const finalNamePreview = computeFinalNamePreview(file?.name, desiredName);

  // Determine target folder constraints
  const needsSubfolderSelection =
    useSubfolder &&
    ((subfolderMode === "existing" && !subfolderId) ||
      (subfolderMode === "new" && !newSubfolderName.trim()));

  const canUpload =
    !!file &&
    !!folderId &&
    desiredName.trim().length > 0 &&
    !busy &&
    !needsSubfolderSelection;

  // Create folder if needed (new mode)
  async function ensureSubfolderIfNeeded() {
    setSubfolderWarning("");

    if (!useSubfolder) return { subfolderId: "" };

    if (subfolderMode === "existing") {
      return { subfolderId };
    }

    // new
    const name = newSubfolderName.trim();
    if (!name) {
      setSubfolderWarning("Please enter a new subfolder name.");
      throw new Error("Missing subfolder name.");
    }

    const res = await fetch(`${API}/api/subfolders`, {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        ...getUploadHeaders(),
      },
      body: JSON.stringify({ parentId: folderId, name }),
    });

    const contentType = res.headers.get("content-type") || "";
    const payload = contentType.includes("application/json")
      ? await res.json()
      : { raw: await res.text() };

    if (res.status === 409) {
      // folder name exists: block creation
      const msg =
        payload?.error ||
        `A folder named "${name}" already exists. Please pick another name.`;
      setSubfolderWarning(msg);
      throw new Error(msg);
    }

    if (!res.ok) {
      const msg =
        payload?.error ||
        payload?.message ||
        payload?.raw ||
        `Failed to create folder (${res.status})`;
      setSubfolderWarning(msg);
      throw new Error(msg);
    }

    // refresh subfolder list (so it appears in dropdown too)
    const createdId = payload.id;
    const createdName = payload.name;

    // Add locally + sort
    const next = [...subfolders, { id: createdId, name: createdName }].sort(
      (a, b) =>
        String(a.name || "").localeCompare(String(b.name || ""), undefined, {
          sensitivity: "base",
        })
    );
    setSubfolders(next);

    // Auto-switch to existing + select created
    setSubfolderMode("existing");
    setSubfolderId(createdId);
    setNewSubfolderName("");

    setStatus(`Subfolder created: ${createdName}`);
    return { subfolderId: createdId };
  }

  async function uploadFile(confirmDuplicate = false) {
    if (!file) return setStatus("Pick a file first.");
    if (!folderId) return setStatus("Pick a folder first.");
    if (!desiredName.trim())
      return setStatus("Please enter a file name before uploading.");

    setBusy(true);
    setStatus("Uploading...");
    setDuplicateWarning(false);
    setSubfolderWarning("");

    try {
      // If user chose "new subfolder", create it first
      const { subfolderId: createdOrSelectedSubfolderId } =
        await ensureSubfolderIfNeeded();

      const form = new FormData();
      form.append("folderId", folderId);
      if (useSubfolder && createdOrSelectedSubfolderId) {
        form.append("subfolderId", createdOrSelectedSubfolderId);
      }
      form.append("file", file);
      form.append("desiredName", desiredName.trim());
      if (confirmDuplicate) form.append("confirmDuplicate", "true");

      const res = await fetch(`${API}/api/upload`, {
        method: "POST",
        body: form,
        headers: getUploadHeaders(),
      });

      const contentType = res.headers.get("content-type") || "";
      const payload = contentType.includes("application/json")
        ? await res.json()
        : { raw: await res.text() };

      if (res.status === 409) {
        setDuplicateWarning(true);
        setStatus(
          payload?.message ||
            `A file named "${finalNamePreview}" already exists.`
        );
        return;
      }

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

  // Bold only when folders loaded
  const statusIsBold = status === "Folders loaded.";

  return (
    <div style={styles.page}>
      <div style={styles.card}>
        <h2 style={{ marginTop: 0 }}>Upload to Google Drive</h2>

        <label style={styles.label}>
          Choose main folder:
          <select
            style={styles.input}
            value={folderId}
            onChange={(e) => {
              setFolderId(e.target.value);
              setDuplicateWarning(false);
              setSubfolderWarning("");
              // if we’re using subfolders, reset selection until loaded
              setSubfolderId("");
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

        {/* Subfolder toggle */}
        <div style={{ marginTop: 14 }}>
          <label style={{ display: "flex", gap: 10, alignItems: "center" }}>
            <input
              type="checkbox"
              checked={useSubfolder}
              onChange={(e) => {
                const checked = e.target.checked;
                setUseSubfolder(checked);
                setDuplicateWarning(false);
                setSubfolderWarning("");
                if (!checked) {
                  setSubfolderId("");
                  setNewSubfolderName("");
                }
              }}
              disabled={busy}
            />
            <span style={{ fontWeight: 700 }}>
              Upload into a subfolder (optional)
            </span>
          </label>

          {useSubfolder && (
            <div style={styles.subBox}>
              <div style={{ display: "flex", gap: 14, flexWrap: "wrap" }}>
                <label style={styles.radio}>
                  <input
                    type="radio"
                    name="submode"
                    value="existing"
                    checked={subfolderMode === "existing"}
                    onChange={() => {
                      setSubfolderMode("existing");
                      setSubfolderWarning("");
                      // pick first if available
                      setSubfolderId(subfolders[0]?.id || "");
                    }}
                    disabled={busy}
                  />
                  Existing subfolder
                </label>

                <label style={styles.radio}>
                  <input
                    type="radio"
                    name="submode"
                    value="new"
                    checked={subfolderMode === "new"}
                    onChange={() => {
                      setSubfolderMode("new");
                      setSubfolderWarning("");
                      setSubfolderId("");
                    }}
                    disabled={busy}
                  />
                  New subfolder
                </label>
              </div>

              {subfolderMode === "existing" && (
                <>
                  <label style={styles.labelThin}>
                    Pick subfolder:
                    <select
                      style={styles.input}
                      value={subfolderId}
                      onChange={(e) => {
                        setSubfolderId(e.target.value);
                        setSubfolderWarning("");
                      }}
                      disabled={busy}
                    >
                      {subfolders.map((f) => (
                        <option key={f.id} value={f.id}>
                          {f.name}
                        </option>
                      ))}
                    </select>
                  </label>

                  {!subfolders.length && (
                    <div style={styles.warn}>
                      No subfolders found in this folder. Switch to “New
                      subfolder” to create one.
                    </div>
                  )}
                </>
              )}

              {subfolderMode === "new" && (
                <label style={styles.labelThin}>
                  New subfolder name:
                  <input
                    style={styles.input}
                    value={newSubfolderName}
                    onChange={(e) => {
                      setNewSubfolderName(e.target.value);
                      setSubfolderWarning("");
                    }}
                    placeholder="e.g. Team 3 - Part 2"
                    disabled={busy}
                  />
                  <div style={styles.subtle}>
                    Must be unique (cannot match an existing subfolder).
                  </div>
                </label>
              )}

              {!!subfolderWarning && (
                <div style={styles.warnBox}>
                  <div style={styles.warnTitle}>Subfolder issue</div>
                  <div style={styles.warnText}>{subfolderWarning}</div>
                </div>
              )}
            </div>
          )}
        </div>

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
            <code style={styles.codeChip}>
              {finalNamePreview || "(pick a file first)"}
            </code>
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
          onClick={() => uploadFile(false)}
          disabled={!canUpload}
        >
          {busy ? "Uploading..." : "Upload"}
        </button>

        {/* Duplicate warning (files) */}
        {duplicateWarning && (
          <div style={styles.warnBox}>
            <div style={styles.warnTitle}>Duplicate name</div>

            <div style={styles.warnText}>
              A file named{" "}
              <code style={styles.codeChip}>{finalNamePreview}</code> already
              exists in this folder.
              <br />
              Uploading anyway will save as{" "}
              <code style={styles.codeChip}>name (2)</code>,{" "}
              <code style={styles.codeChip}>name (3)</code>, etc.
            </div>

            <div style={{ display: "flex", gap: 10, flexWrap: "wrap" }}>
              <button
                style={styles.button}
                onClick={() => uploadFile(true)}
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

        {/* Status box (better readability on iPhone) */}
        <pre style={styles.status}>
          <span style={statusIsBold ? styles.statusBold : undefined}>
            {status}
          </span>
        </pre>

        <div style={styles.hint}>
          API: <code style={styles.codeChip}>{API}</code>
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

  label: { display: "block", marginTop: 14, fontWeight: 700 },
  labelThin: { display: "block", marginTop: 12, fontWeight: 600 },

  input: { display: "block", width: "100%", marginTop: 8, padding: 10 },

  subBox: {
    marginTop: 10,
    padding: 12,
    borderRadius: 12,
    border: "1px solid #eee",
    background: "#fafafa",
  },

  radio: { display: "flex", alignItems: "center", gap: 8, fontWeight: 600 },

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
    background: "#f3f3f3",
    cursor: "pointer",
  },

  // ✅ Improved readability on iPhone: darker text + stronger border
  status: {
    marginTop: 16,
    background: "#fafafa",
    padding: 12,
    borderRadius: 10,
    whiteSpace: "pre-wrap",
    border: "1px solid #e6e6e6",
    color: "#111",
    lineHeight: 1.35,
  },
  statusBold: {
    fontWeight: 800,
  },

  hint: { marginTop: 12, fontSize: 12, opacity: 0.8 },
  subtle: { marginTop: 8, fontSize: 12, opacity: 0.85 },

  codeChip: {
    padding: "2px 6px",
    borderRadius: 8,
    border: "1px solid #e5e5e5",
    background: "#fff",
  },

  warn: {
    marginTop: 8,
    padding: "8px 10px",
    borderRadius: 10,
    border: "1px solid #f0d28a",
    background: "#fff8e1",
    fontSize: 12,
    lineHeight: 1.3,
    color: "#111",
  },

  warnBox: {
    marginTop: 14,
    padding: 14,
    borderRadius: 12,
    border: "1px solid #f0c36d",
    background: "#fff8e1",
    color: "#111",
  },
  warnTitle: {
    fontWeight: 900,
    marginBottom: 6,
  },
  warnText: {
    fontSize: 13,
    lineHeight: 1.35,
    marginBottom: 10,
  },
};
