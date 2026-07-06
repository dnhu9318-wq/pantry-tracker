import React, { useState, useEffect, useRef, useCallback } from "react";
// ZXing loaded dynamically for full barcode support (UPC, EAN, QR, etc)

// ─────────────────────────────────────────────────────────────────────────────
// CONFIGURATION — fill these in after following the setup guide
// ─────────────────────────────────────────────────────────────────────────────
const GOOGLE_API_KEY    = "AIzaSyCT1vpcY0R4qSKb8wpmypsQTTyGhUZ2Qms ";
const SPREADSHEET_ID    = "1KOtHFxDloJZqORXmTzZ-JM0R2eF6v-jongLhKIaFFI8";
const SHEET_NAME        = "Inventory";  // must match your tab name exactly
const CLIENT_ID         = "1083919079784-tv13b0nckcspcll1frfgq6saktk9tcrh.apps.googleusercontent.com";
const SCOPES            = "https://www.googleapis.com/auth/spreadsheets";

// ── helpers ───────────────────────────────────────────────────────────────────
const todayStr = () => new Date().toISOString().split("T")[0];
const nowStr   = () => new Date().toLocaleString();

const daysUntil = (dateStr) => {
  if (!dateStr) return null;
  return Math.ceil((new Date(dateStr) - new Date(todayStr())) / 86400000);
};
const expiryColor = (d) => {
  if (d === null) return "";
  if (d < 0) return "#ef4444";
  if (d <= 3) return "#f97316";
  if (d <= 7) return "#eab308";
  return "#22c55e";
};
const expiryLabel = (d) => {
  if (d === null) return "";
  if (d < 0) return `Expired ${Math.abs(d)}d ago`;
  if (d === 0) return "Expires today";
  if (d === 1) return "Expires tomorrow";
  return `${d}d left`;
};
const uid = () => Math.random().toString(36).slice(2, 10);

// ── Google Sheets helpers ─────────────────────────────────────────────────────
const HEADERS = [
  "Timestamp Scanned", "Product Name", "Brand", "Quantity", "Unit",
  "Expiry Date", "Calories (kcal)", "Total Fat (g)", "Saturated Fat (g)",
  "Trans Fat (g)", "Cholesterol (mg)", "Sodium (mg)", "Total Carbs (g)",
  "Dietary Fiber (g)", "Total Sugars (g)", "Protein (g)",
  "Vitamin D (mcg)", "Calcium (mg)", "Iron (mg)", "Potassium (mg)",
  "Nutri-Score", "Allergens", "Notes", "Barcode"
];

const itemToRow = (item) => {
  const n = item.nutrition || {};
  const fmt = (v) => v != null ? Number(v).toFixed(1) : "";
  const fmtInt = (v) => v != null ? Math.round(Number(v)) : "";
  return [
    item.addedAt || nowStr(),
    item.name || "",
    item.brand || "",
    item.quantity ?? "",
    item.unit || "",
    item.expiry || "",
    fmtInt(n.calories),
    fmt(n.fat),
    fmt(n.saturatedFat),
    fmt(n.transFat),
    fmtInt(n.cholesterol),
    fmtInt(n.sodium),
    fmt(n.carbs),
    fmt(n.fiber),
    fmt(n.sugars),
    fmt(n.protein),
    fmt(n.vitaminD),
    fmtInt(n.calcium),
    fmt(n.iron),
    fmtInt(n.potassium),
    n.nutriScore || "",
    n.allergens || "",
    item.notes || "",
    item.barcode || "",
  ];
};

// Load Google Identity Services only (no gapi client needed)
const loadGisScript = () => new Promise((resolve, reject) => {
  if (window.google?.accounts) { resolve(); return; }
  const s = document.createElement("script");
  s.src = "https://accounts.google.com/gsi/client";
  s.async = true;
  s.onload = resolve;
  s.onerror = () => reject(new Error("Failed to load Google sign-in script."));
  document.head.appendChild(s);
});

// Plain fetch-based Sheets API calls
const sheetsRequest = async (method, path, body, token) => {
  const base = "https://sheets.googleapis.com/v4/spreadsheets";
  const res = await fetch(`${base}/${path}`, {
    method,
    headers: {
      "Authorization": `Bearer ${token}`,
      "Content-Type": "application/json",
    },
    body: body ? JSON.stringify(body) : undefined,
  });
  if (!res.ok) throw new Error(`Sheets API error: ${res.status}`);
  return res.json();
};

// ── Open Food Facts ───────────────────────────────────────────────────────────
const fetchNutrition = async (barcode) => {
  try {
    const res  = await fetch(`https://world.openfoodfacts.org/api/v0/product/${barcode}.json`);
    const data = await res.json();
    if (data.status !== 1) return null;
    const p = data.product, n = p.nutriments || {};

    // Prefer _serving values (matches US food label), fall back to _100g
    // Open Food Facts sometimes stores values under different key formats
    const get = (base) => {
      // Try serving first (what the label shows)
      if (n[base + "_serving"] != null) return n[base + "_serving"];
      // Try without suffix (sometimes stored at root level)
      if (n[base] != null && typeof n[base] === "number") return n[base];
      // Fall back to per 100g
      if (n[base + "_100g"] != null) return n[base + "_100g"];
      return null;
    };

    // Sodium & cholesterol stored in kg in OFF, need conversion to mg
    const getSodium = () => {
      if (n["sodium_serving"] != null) return n["sodium_serving"] * 1000;
      if (n["salt_serving"] != null) return n["salt_serving"] * 400; // salt to sodium approx
      if (n["sodium_100g"] != null) return n["sodium_100g"] * 1000;
      return null;
    };
    const getCholesterol = () => {
      if (n["cholesterol_serving"] != null) return n["cholesterol_serving"] * 1000;
      if (n["cholesterol_100g"] != null) return n["cholesterol_100g"] * 1000;
      return null;
    };
    const getMicro = (base) => {
      // micronutrients stored in kg, convert to mg
      if (n[base + "_serving"] != null) return n[base + "_serving"] * 1000;
      if (n[base + "_100g"] != null) return n[base + "_100g"] * 1000;
      return null;
    };

    const hasServing = n["energy-kcal_serving"] != null || n["fat_serving"] != null;

    return {
      name:         p.product_name || p.product_name_en || "",
      brand:        p.brands || "",
      imageUrl:     p.image_front_small_url || p.image_url || "",
      nutriScore:   p.nutriscore_grade?.toUpperCase() || "",
      servingSize:  p.serving_size || p.serving_quantity || "",
      calories:     n["energy-kcal_serving"] ?? n["energy-kcal_100g"] ?? null,
      caloriesUnit: hasServing ? "per serving" : "per 100g",
      fat:          get("fat"),
      saturatedFat: get("saturated-fat"),
      transFat:     get("trans-fat"),
      cholesterol:  getCholesterol(),
      carbs:        get("carbohydrates"),
      sugars:       get("sugars"),
      fiber:        get("fiber"),
      protein:      get("proteins"),
      sodium:       getSodium(),
      vitaminD:     getMicro("vitamin-d"),
      calcium:      getMicro("calcium"),
      iron:         getMicro("iron"),
      potassium:    getMicro("potassium"),
      ingredients:  p.ingredients_text || "",
      allergens:    p.allergens_tags?.map(a => a.replace("en:", "")).join(", ") || "",
    };
  } catch { return null; }
};

// ── Barcode scanner (ZXing — reads UPC, EAN, QR, Code128, etc) ──────────────
function BarcodeScanner({ onDetected, onClose }) {
  const videoRef     = useRef(null);
  const streamRef    = useRef(null);
  const readerRef    = useRef(null);
  const [status, setStatus]   = useState("Tap the button below to start your camera");
  const [started, setStarted] = useState(false);
  const [error, setError]     = useState(false);
  const [zxingReady, setZxingReady] = useState(!!window.ZXing);

  useEffect(() => {
    if (window.ZXing) { setZxingReady(true); return; }
    const s = document.createElement("script");
    s.src = "https://unpkg.com/@zxing/library@0.19.1/umd/index.min.js";
    s.async = true;
    s.onload = () => setZxingReady(true);
    s.onerror = () => setStatus("Failed to load barcode library. Check your connection.");
    document.head.appendChild(s);
  }, []);

  const startCamera = async () => {
    if (!zxingReady) { setStatus("Barcode library still loading, please wait…"); return; }
    setStarted(true);
    setStatus("Starting camera…");
    setError(false);
    try {
      const hints = new Map();
      const formats = [
        window.ZXing.BarcodeFormat.EAN_13,
        window.ZXing.BarcodeFormat.EAN_8,
        window.ZXing.BarcodeFormat.UPC_A,
        window.ZXing.BarcodeFormat.UPC_E,
        window.ZXing.BarcodeFormat.CODE_128,
        window.ZXing.BarcodeFormat.CODE_39,
        window.ZXing.BarcodeFormat.QR_CODE,
        window.ZXing.BarcodeFormat.DATA_MATRIX,
      ];
      hints.set(window.ZXing.DecodeHintType.POSSIBLE_FORMATS, formats);
      hints.set(window.ZXing.DecodeHintType.TRY_HARDER, true);
      const reader = new window.ZXing.BrowserMultiFormatReader(hints);
      readerRef.current = reader;
      const stream = await navigator.mediaDevices.getUserMedia({
        video: { facingMode: "environment", width: { ideal: 1280 }, height: { ideal: 720 } }
      });
      streamRef.current = stream;
      const v = videoRef.current;
      if (!v) return;
      v.srcObject = stream;
      await v.play();
      setStatus("Point camera at a barcode or QR code");
      reader.decodeFromStream(stream, v, (result, err) => {
        if (result) {
          onDetected(result.getText());
        }
      });
    } catch (e) {
      setError(true);
      setStarted(false);
      if (e.name === "NotAllowedError") {
        setStatus("Camera access denied. Go to Settings → Safari → Camera → Allow, then try again.");
      } else if (e.name === "NotFoundError") {
        setStatus("No camera found on this device.");
      } else {
        setStatus("Camera error: " + e.message);
      }
    }
  };

  useEffect(() => {
    return () => {
      if (readerRef.current) { try { readerRef.current.reset(); } catch {} }
      if (streamRef.current) streamRef.current.getTracks().forEach(t => t.stop());
    };
  }, []);

  return (
    <div style={{ position:"fixed", inset:0, background:"#000", display:"flex",
      flexDirection:"column", alignItems:"center", justifyContent:"center", zIndex:999 }}>
      <div style={{ position:"relative", width:"100%", maxWidth:480 }}>
        <video ref={videoRef} style={{ width:"100%", display:"block", minHeight: started ? "auto" : 0 }}
          playsInline muted autoPlay />
        {started && (
          <div style={{ position:"absolute", inset:0, boxShadow:"inset 0 0 0 9999px rgba(0,0,0,0.45)" }}>
            <div style={{ position:"absolute", top:"25%", left:"10%", width:"80%", height:"50%",
              border:"2px solid #4ade80", borderRadius:8 }} />
          </div>
        )}
      </div>
      <p style={{ color: error ? "#fca5a5" : "#fff", marginTop:16, fontSize:14,
        textAlign:"center", padding:"0 24px", lineHeight:1.6 }}>{status}</p>
      <div style={{ display:"flex", flexDirection:"column", gap:12, marginTop:16, alignItems:"center" }}>
        {!started && (
          <button onClick={startCamera} style={{ padding:"14px 40px", background:"#22c55e",
            color:"#fff", border:"none", borderRadius:10, cursor:"pointer",
            fontSize:16, fontWeight:700, boxShadow:"0 4px 16px rgba(34,197,94,0.4)" }}>
            📷 Start Camera
          </button>
        )}
        <button onClick={onClose} style={{ padding:"10px 32px", background:"#ef4444",
          color:"#fff", border:"none", borderRadius:8, cursor:"pointer", fontSize:15, fontWeight:600 }}>
          Cancel
        </button>
      </div>
    </div>
  );
}

// ── Nutrition panel ───────────────────────────────────────────────────────────
function NutritionPanel({ nutrition, onClose }) {
  if (!nutrition) return null;
  const scoreColors = { A:"#22c55e", B:"#84cc16", C:"#eab308", D:"#f97316", E:"#ef4444" };
  const NRow = ({ label, val, unit="g" }) => {
    if (val == null) return null;
    return (
      <tr>
        <td style={{ padding:"4px 8px", color:"#64748b", fontSize:13 }}>{label}</td>
        <td style={{ padding:"4px 8px", textAlign:"right", fontSize:13, fontWeight:500 }}>
          {typeof val === "number" ? val.toFixed(1) : val}{unit}
        </td>
      </tr>
    );
  };
  return (
    <div style={{ position:"fixed", inset:0, background:"rgba(0,0,0,0.5)", display:"flex",
      alignItems:"flex-end", justifyContent:"center", zIndex:500 }} onClick={onClose}>
      <div onClick={e => e.stopPropagation()} style={{ background:"#fff", borderRadius:"20px 20px 0 0",
        padding:"24px 20px 40px", width:"100%", maxWidth:480, maxHeight:"85vh", overflowY:"auto" }}>
        <div style={{ display:"flex", gap:12, marginBottom:16 }}>
          {nutrition.imageUrl && (
            <img src={nutrition.imageUrl} alt="" style={{ width:72, height:72, objectFit:"contain",
              borderRadius:8, border:"1px solid #e2e8f0", flexShrink:0 }} />
          )}
          <div>
            <p style={{ margin:0, fontWeight:700, fontSize:16, color:"#0f172a" }}>{nutrition.name || "Unknown"}</p>
            {nutrition.brand && <p style={{ margin:"2px 0 0", fontSize:13, color:"#64748b" }}>{nutrition.brand}</p>}
            <div style={{ display:"flex", gap:8, marginTop:6, flexWrap:"wrap" }}>
              {nutrition.calories != null && (
                <span style={{ background:"#f1f5f9", borderRadius:20, padding:"2px 10px", fontSize:13, fontWeight:600 }}>
                  🔥 {Math.round(nutrition.calories)} kcal {nutrition.caloriesUnit}
                </span>
              )}
              {nutrition.nutriScore && (
                <span style={{ background: scoreColors[nutrition.nutriScore] || "#94a3b8",
                  color:"#fff", borderRadius:20, padding:"2px 10px", fontSize:13, fontWeight:700 }}>
                  Nutri-Score {nutrition.nutriScore}
                </span>
              )}
            </div>
          </div>
        </div>
        <table style={{ width:"100%", borderCollapse:"collapse", marginBottom:12 }}>
          <tbody>
            <NRow label="Calories (kcal)" val={nutrition.calories != null ? Math.round(nutrition.calories) : null} unit="" />
            <NRow label="Fat" val={nutrition.fat} />
            <NRow label="— Saturated fat" val={nutrition.saturatedFat} />
            <NRow label="Carbohydrates" val={nutrition.carbs} />
            <NRow label="— Sugars" val={nutrition.sugars} />
            <NRow label="Dietary fiber" val={nutrition.fiber} />
            <NRow label="Protein" val={nutrition.protein} />
            <NRow label="Sodium" val={nutrition.sodium} unit="mg" />
          </tbody>
        </table>
        {nutrition.allergens && (
          <div style={{ background:"#fff7ed", borderRadius:8, padding:"8px 12px",
            fontSize:13, color:"#92400e", marginBottom:10 }}>
            ⚠️ <strong>Allergens:</strong> {nutrition.allergens}
          </div>
        )}
        {nutrition.ingredients && (
          <div>
            <p style={{ margin:"0 0 4px", fontSize:12, fontWeight:600, color:"#64748b",
              textTransform:"uppercase", letterSpacing:"0.05em" }}>Ingredients</p>
            <p style={{ margin:0, fontSize:12, color:"#475569", lineHeight:1.6 }}>{nutrition.ingredients}</p>
          </div>
        )}
        <button onClick={onClose} style={{ marginTop:20, width:"100%", padding:"12px",
          background:"#0f172a", color:"#fff", border:"none", borderRadius:10,
          cursor:"pointer", fontSize:15, fontWeight:600 }}>Close</button>
      </div>
    </div>
  );
}

// ── Item form ─────────────────────────────────────────────────────────────────
function ItemForm({ initial, onSave, onCancel, scannedBarcode }) {
  const [form, setForm] = useState(() => initial || {
    name:"", brand:"", quantity:1, unit:"pcs",
    expiry:"", notes:"", barcode: scannedBarcode || "",
    nutrition:null, imageUrl:""
  });
  const [fetching, setFetching]   = useState(false);
  const [fetchMsg, setFetchMsg]   = useState("");

  const set = (k, v) => setForm(f => ({ ...f, [k]: v }));

  const lookupBarcode = async (code) => {
    if (!code) return;
    setFetching(true); setFetchMsg("Looking up product…");
    const n = await fetchNutrition(code);
    setFetching(false);
    if (n) {
      setFetchMsg("✓ Product found!");
      setForm(f => ({ ...f, nutrition:n, name: f.name||n.name||"", brand: f.brand||n.brand||"", imageUrl: f.imageUrl||n.imageUrl||"" }));
    } else {
      setFetchMsg("Product not found. Enter details manually.");
    }
    setTimeout(() => setFetchMsg(""), 3000);
  };

  useEffect(() => { if (scannedBarcode && !initial) lookupBarcode(scannedBarcode); }, []);

  const inp = (extra={}) => ({
    width:"100%", padding:"10px 12px", borderRadius:8, border:"1.5px solid #e2e8f0",
    fontSize:14, outline:"none", boxSizing:"border-box", fontFamily:"inherit", background:"#f8fafc", ...extra
  });
  const Lbl = ({ children }) => (
    <label style={{ display:"block", fontSize:12, fontWeight:600, color:"#64748b",
      textTransform:"uppercase", letterSpacing:"0.05em", marginBottom:4 }}>{children}</label>
  );

  return (
    <div style={{ position:"fixed", inset:0, background:"rgba(0,0,0,0.45)", display:"flex",
      alignItems:"flex-end", justifyContent:"center", zIndex:400 }}>
      <div style={{ background:"#fff", borderRadius:"20px 20px 0 0", padding:"24px 20px 40px",
        width:"100%", maxWidth:480, maxHeight:"90vh", overflowY:"auto" }}>
        <h2 style={{ margin:"0 0 20px", fontSize:18, color:"#0f172a" }}>{initial ? "Edit item" : "Add item"}</h2>
        {form.imageUrl && (
          <img src={form.imageUrl} alt="" style={{ height:80, objectFit:"contain",
            display:"block", margin:"0 auto 16px", borderRadius:8 }} />
        )}
        <div style={{ marginBottom:14 }}>
          <Lbl>Product name *</Lbl>
          <input style={inp()} value={form.name} placeholder="e.g. Tomato Soup"
            onChange={e => set("name", e.target.value)} />
        </div>
        <div style={{ marginBottom:14 }}>
          <Lbl>Brand</Lbl>
          <input style={inp()} value={form.brand} placeholder="e.g. Campbell's"
            onChange={e => set("brand", e.target.value)} />
        </div>
        <div style={{ display:"flex", gap:10, marginBottom:14 }}>
          <div style={{ flex:2 }}>
            <Lbl>Quantity</Lbl>
            <input type="number" min={0} style={inp()} value={form.quantity}
              onChange={e => set("quantity", Number(e.target.value))} />
          </div>
          <div style={{ flex:2 }}>
            <Lbl>Unit</Lbl>
            <select style={inp()} value={form.unit} onChange={e => set("unit", e.target.value)}>
              {["pcs","cans","bags","boxes","bottles","kg","g","lbs","oz","L","mL"].map(u => <option key={u}>{u}</option>)}
            </select>
          </div>
        </div>
        <div style={{ marginBottom:14 }}>
          <Lbl>Expiry date</Lbl>
          <input type="date" style={inp()} value={form.expiry} onChange={e => set("expiry", e.target.value)} />
        </div>
        <div style={{ marginBottom:14 }}>
          <Lbl>Barcode (optional)</Lbl>
          <div style={{ display:"flex", gap:8 }}>
            <input style={inp({ flex:1 })} value={form.barcode} placeholder="Enter barcode number"
              onChange={e => set("barcode", e.target.value)} />
            <button onClick={() => lookupBarcode(form.barcode)} disabled={fetching}
              style={{ padding:"10px 14px", background:"#0f172a", color:"#fff", border:"none",
                borderRadius:8, cursor:"pointer", fontSize:13, fontWeight:600, whiteSpace:"nowrap" }}>
              {fetching ? "…" : "Lookup"}
            </button>
          </div>
          {fetchMsg && <p style={{ margin:"4px 0 0", fontSize:12, color:"#64748b" }}>{fetchMsg}</p>}
        </div>
        <div style={{ marginBottom:20 }}>
          <Lbl>Notes</Lbl>
          <textarea style={inp({ resize:"vertical", minHeight:72 })} value={form.notes}
            placeholder="Storage tips, location in pantry…" onChange={e => set("notes", e.target.value)} />
        </div>
        <div style={{ display:"flex", gap:10 }}>
          <button onClick={onCancel} style={{ flex:1, padding:"12px", background:"#f1f5f9",
            color:"#475569", border:"none", borderRadius:10, cursor:"pointer", fontSize:15, fontWeight:600 }}>
            Cancel
          </button>
          <button onClick={() => form.name.trim() && onSave(form)}
            style={{ flex:2, padding:"12px", background:"#0f172a", color:"#fff", border:"none",
              borderRadius:10, cursor:"pointer", fontSize:15, fontWeight:600 }}>
            Save & sync to Sheet
          </button>
        </div>
      </div>
    </div>
  );
}

// ── Main app ──────────────────────────────────────────────────────────────────
export default function PantryTracker() {
  const [items, setItems]             = useState([]);
  const [scanning, setScanning]       = useState(false);
  const [scannedBarcode, setScanned]  = useState(null);
  const [showForm, setShowForm]       = useState(false);
  const [editItem, setEditItem]       = useState(null);
  const [viewNutrition, setViewNut]   = useState(null);
  const [search, setSearch]           = useState("");
  const [filter, setFilter]           = useState("all");
  const [toast, setToast]             = useState("");
  const [sheetStatus, setSheetStatus] = useState("idle"); // idle | signing-in | ready | error
  const [sheetMsg, setSheetMsg]       = useState("");
  const tokenClientRef                = useRef(null);
  const accessTokenRef                = useRef(null);

  const showToast = (msg) => { setToast(msg); setTimeout(() => setToast(""), 3000); };

  // ── Google Auth ─────────────────────────────────────────────────────────────
  const connectGoogle = async () => {
    const isConfigured = CLIENT_ID !== "YOUR_CLIENT_ID_HERE" &&
                         SPREADSHEET_ID !== "YOUR_SPREADSHEET_ID_HERE";
    if (!isConfigured) {
      setSheetMsg("⚠️ Please fill in your Client ID and Spreadsheet ID at the top of the code first.");
      setSheetStatus("error");
      return;
    }
    setSheetStatus("signing-in");
    setSheetMsg("Loading Google sign-in…");
    try {
      const timeout = new Promise((_, reject) =>
        setTimeout(() => reject(new Error("Timed out. Check your internet connection and try again.")), 15000)
      );
      await Promise.race([loadGisScript(), timeout]);
      setSheetMsg("Opening sign-in window…");
      tokenClientRef.current = window.google.accounts.oauth2.initTokenClient({
        client_id: CLIENT_ID,
        scope: SCOPES,
        callback: async (resp) => {
          if (resp.error) { setSheetStatus("error"); setSheetMsg("Sign-in failed: " + resp.error); return; }
          accessTokenRef.current = resp.access_token;
          setSheetMsg("Checking spreadsheet…");
          await ensureHeaderRow(resp.access_token);
          setSheetStatus("ready");
          setSheetMsg("✓ Connected to Google Sheets!");
          showToast("Connected to Google Sheets!");
        },
      });
      tokenClientRef.current.requestAccessToken({ prompt: "" });
    } catch (e) {
      setSheetStatus("error");
      setSheetMsg("Error: " + e.message);
    }
  };

  const ensureHeaderRow = async (token) => {
    try {
      const res = await sheetsRequest(
        "GET",
        `${SPREADSHEET_ID}/values/${SHEET_NAME}!A1:O1`,
        null,
        token || accessTokenRef.current
      );
      const existing = res.values?.[0];
      if (!existing || existing.length === 0) {
        await sheetsRequest(
          "PUT",
          `${SPREADSHEET_ID}/values/${SHEET_NAME}!A1?valueInputOption=RAW`,
          { values: [HEADERS] },
          token || accessTokenRef.current
        );
      }
    } catch {}
  };

  const appendToSheet = async (item) => {
    if (sheetStatus !== "ready" || !accessTokenRef.current) return;
    try {
      await sheetsRequest(
        "POST",
        `${SPREADSHEET_ID}/values/${SHEET_NAME}!A1:append?valueInputOption=USER_ENTERED&insertDataOption=INSERT_ROWS`,
        { values: [itemToRow(item)] },
        accessTokenRef.current
      );
      showToast("✓ Saved to Google Sheets!");
    } catch (e) {
      showToast("Sheet sync failed: " + e.message);
    }
  };

  const updateSheetRow = async (item) => {
    if (sheetStatus !== "ready" || !accessTokenRef.current) return;
    try {
      const row = itemToRow(item);
      row[0] = nowStr() + " (updated)";
      await sheetsRequest(
        "POST",
        `${SPREADSHEET_ID}/values/${SHEET_NAME}!A1:append?valueInputOption=USER_ENTERED&insertDataOption=INSERT_ROWS`,
        { values: [row] },
        accessTokenRef.current
      );
      showToast("✓ Update synced to Google Sheets!");
    } catch {}
  };

  // ── Scan + save ─────────────────────────────────────────────────────────────
  const handleScan = useCallback((code) => {
    setScanning(false); setScanned(code); setShowForm(true);
  }, []);

  const handleSave = async (form) => {
    const enriched = { ...form, addedAt: nowStr() };
    if (editItem) {
      setItems(prev => prev.map(i => i.id === editItem.id ? { ...enriched, id: i.id } : i));
      showToast("Item updated");
      await updateSheetRow({ ...enriched, id: editItem.id });
    } else {
      const newItem = { ...enriched, id: uid() };
      setItems(prev => [newItem, ...prev]);
      showToast("Item added");
      await appendToSheet(newItem);
    }
    setShowForm(false); setEditItem(null); setScanned(null);
  };

  const handleDelete = (id) => {
    if (window.confirm("Remove this item?")) {
      setItems(prev => prev.filter(i => i.id !== id));
      showToast("Item removed");
    }
  };

  const handleQty = (id, delta) => {
    setItems(prev => prev.map(i =>
      i.id === id ? { ...i, quantity: Math.max(0, i.quantity + delta) } : i));
  };

  const filtered = items.filter(item => {
    const ms = !search ||
      item.name.toLowerCase().includes(search.toLowerCase()) ||
      (item.brand||"").toLowerCase().includes(search.toLowerCase());
    const d = daysUntil(item.expiry);
    const mf = filter === "expiring" ? (d !== null && d >= 0 && d <= 7)
             : filter === "expired"  ? (d !== null && d < 0)
             : true;
    return ms && mf;
  }).sort((a, b) => {
    const da = daysUntil(a.expiry), db = daysUntil(b.expiry);
    if (da === null && db === null) return 0;
    if (da === null) return 1; if (db === null) return -1;
    return da - db;
  });

  const expiringSoon = items.filter(i => { const d = daysUntil(i.expiry); return d !== null && d >= 0 && d <= 7; }).length;
  const expired      = items.filter(i => { const d = daysUntil(i.expiry); return d !== null && d < 0; }).length;

  // ── Render ──────────────────────────────────────────────────────────────────
  return (
    <div style={{ minHeight:"100vh", background:"#f8fafc",
      fontFamily:"'Inter', system-ui, sans-serif", maxWidth:480, margin:"0 auto", position:"relative" }}>

      {/* Header */}
      <div style={{ background:"#0f172a", color:"#fff", padding:"20px 20px 16px",
        position:"sticky", top:0, zIndex:100 }}>
        <h1 style={{ margin:"0 0 2px", fontSize:22, fontWeight:800, letterSpacing:"-0.02em" }}>
          🥫 Pantry Tracker
        </h1>
        <p style={{ margin:"0 0 10px", fontSize:13, color:"#94a3b8" }}>
          {items.length} item{items.length !== 1 ? "s" : ""} ·{" "}
          {expired > 0 && <span style={{ color:"#ef4444" }}>{expired} expired · </span>}
          {expiringSoon > 0 && <span style={{ color:"#f97316" }}>{expiringSoon} expiring soon</span>}
          {expired === 0 && expiringSoon === 0 && "All good!"}
        </p>

        {/* Google Sheets connect button */}
        <div style={{ marginBottom:10 }}>
          {sheetStatus === "idle" && (
            <button onClick={connectGoogle} style={{ width:"100%", padding:"9px 12px",
              background:"#16a34a", color:"#fff", border:"none", borderRadius:8,
              cursor:"pointer", fontSize:13, fontWeight:600 }}>
              🔗 Connect to Google Sheets
            </button>
          )}
          {sheetStatus === "signing-in" && (
            <div style={{ background:"#1e293b", borderRadius:8, padding:"9px 12px",
              fontSize:13, color:"#94a3b8" }}>⏳ {sheetMsg}</div>
          )}
          {sheetStatus === "ready" && (
            <div style={{ background:"#14532d", borderRadius:8, padding:"9px 12px",
              fontSize:13, color:"#86efac", display:"flex", alignItems:"center", gap:8 }}>
              <span>📊 {sheetMsg}</span>
            </div>
          )}
          {sheetStatus === "error" && (
            <div style={{ background:"#450a0a", borderRadius:8, padding:"9px 12px", fontSize:13, color:"#fca5a5" }}>
              {sheetMsg}
              <button onClick={connectGoogle} style={{ marginLeft:8, background:"none", border:"none",
                color:"#fca5a5", cursor:"pointer", textDecoration:"underline", fontSize:13 }}>Retry</button>
            </div>
          )}
        </div>

        <input style={{ width:"100%", padding:"9px 12px", borderRadius:8, border:"none",
          fontSize:14, background:"#1e293b", color:"#fff", outline:"none",
          boxSizing:"border-box", fontFamily:"inherit" }}
          placeholder="🔍 Search items…" value={search}
          onChange={e => setSearch(e.target.value)} />

        <div style={{ display:"flex", gap:8, marginTop:10 }}>
          {[["all","All"],["expiring","Expiring soon"],["expired","Expired"]].map(([val,lbl]) => (
            <button key={val} onClick={() => setFilter(val)} style={{
              padding:"5px 12px", borderRadius:20, fontSize:12, fontWeight:600,
              border:"none", cursor:"pointer",
              background: filter===val ? "#4ade80" : "#1e293b",
              color: filter===val ? "#0f172a" : "#94a3b8"
            }}>{lbl}</button>
          ))}
        </div>
      </div>

      {/* Items */}
      <div style={{ padding:"16px 16px 120px" }}>
        {filtered.length === 0 && (
          <div style={{ textAlign:"center", padding:"60px 20px", color:"#94a3b8" }}>
            <div style={{ fontSize:48, marginBottom:12 }}>🛒</div>
            <p style={{ margin:0, fontSize:15 }}>
              {items.length === 0 ? "Tap 📷 to scan a product, or ✏️ to add manually." : "No items match this filter."}
            </p>
          </div>
        )}

        {filtered.map(item => {
          const days  = daysUntil(item.expiry);
          const color = expiryColor(days);
          return (
            <div key={item.id} style={{ background:"#fff", borderRadius:14, padding:"14px",
              marginBottom:10, boxShadow:"0 1px 3px rgba(0,0,0,0.07)",
              border: days !== null && days < 0 ? "1.5px solid #fee2e2" : "1.5px solid transparent" }}>
              <div style={{ display:"flex", gap:12, alignItems:"flex-start" }}>
                <div style={{ width:52, height:52, borderRadius:8,
                  background: item.imageUrl ? "transparent" : "#f1f5f9",
                  display:"flex", alignItems:"center", justifyContent:"center",
                  fontSize:24, flexShrink:0, overflow:"hidden" }}>
                  {item.imageUrl
                    ? <img src={item.imageUrl} alt="" style={{ width:"100%", height:"100%", objectFit:"contain" }} />
                    : "🥫"}
                </div>
                <div style={{ flex:1, minWidth:0 }}>
                  <div style={{ display:"flex", justifyContent:"space-between", alignItems:"flex-start" }}>
                    <div style={{ minWidth:0, flex:1 }}>
                      <p style={{ margin:0, fontWeight:700, fontSize:15, color:"#0f172a",
                        whiteSpace:"nowrap", overflow:"hidden", textOverflow:"ellipsis" }}>
                        {item.name || "Unnamed item"}
                      </p>
                      {item.brand && <p style={{ margin:"1px 0 0", fontSize:12, color:"#94a3b8" }}>{item.brand}</p>}
                    </div>
                    <div style={{ display:"flex", gap:6, marginLeft:8, flexShrink:0 }}>
                      {item.nutrition && (
                        <button onClick={() => setViewNut(item.nutrition)}
                          style={{ background:"#f1f5f9", border:"none", borderRadius:6,
                            padding:"4px 8px", cursor:"pointer", fontSize:13 }}>🔬</button>
                      )}
                      <button onClick={() => { setEditItem(item); setShowForm(true); }}
                        style={{ background:"#f1f5f9", border:"none", borderRadius:6,
                          padding:"4px 8px", cursor:"pointer", fontSize:13 }}>✏️</button>
                      <button onClick={() => handleDelete(item.id)}
                        style={{ background:"#fff0f0", border:"none", borderRadius:6,
                          padding:"4px 8px", cursor:"pointer", fontSize:13 }}>🗑️</button>
                    </div>
                  </div>
                  <div style={{ display:"flex", alignItems:"center", gap:10, marginTop:8, flexWrap:"wrap" }}>
                    <div style={{ display:"flex", alignItems:"center", gap:6 }}>
                      <button onClick={() => handleQty(item.id, -1)}
                        style={{ width:26, height:26, borderRadius:6, border:"1.5px solid #e2e8f0",
                          background:"#fff", cursor:"pointer", fontWeight:700, fontSize:16,
                          display:"flex", alignItems:"center", justifyContent:"center" }}>−</button>
                      <span style={{ fontWeight:700, fontSize:15, minWidth:28, textAlign:"center" }}>{item.quantity}</span>
                      <button onClick={() => handleQty(item.id, 1)}
                        style={{ width:26, height:26, borderRadius:6, border:"1.5px solid #e2e8f0",
                          background:"#fff", cursor:"pointer", fontWeight:700, fontSize:16,
                          display:"flex", alignItems:"center", justifyContent:"center" }}>+</button>
                      <span style={{ fontSize:12, color:"#94a3b8" }}>{item.unit}</span>
                    </div>
                    {item.expiry && (
                      <span style={{ fontSize:12, fontWeight:600, color: color||"#64748b",
                        background: color ? color+"18" : "#f1f5f9", borderRadius:20, padding:"2px 10px" }}>
                        {days !== null ? expiryLabel(days) : item.expiry}
                      </span>
                    )}
                    {item.nutrition?.calories != null && (
                      <span style={{ fontSize:12, color:"#94a3b8" }}>
                        🔥 {Math.round(item.nutrition.calories)} kcal
                      </span>
                    )}
                  </div>
                  {item.notes && (
                    <p style={{ margin:"6px 0 0", fontSize:12, color:"#64748b",
                      background:"#f8fafc", borderRadius:6, padding:"4px 8px" }}>
                      💬 {item.notes}
                    </p>
                  )}
                  {item.addedAt && (
                    <p style={{ margin:"4px 0 0", fontSize:11, color:"#cbd5e1" }}>
                      Scanned: {item.addedAt}
                    </p>
                  )}
                </div>
              </div>
            </div>
          );
        })}
      </div>

      {/* FABs */}
      <div style={{ position:"fixed", bottom:28, right:20, display:"flex",
        flexDirection:"column", gap:12, zIndex:200 }}>
        <button onClick={() => { setEditItem(null); setScanned(null); setShowForm(true); }}
          style={{ width:50, height:50, borderRadius:"50%", background:"#475569", color:"#fff",
            border:"none", fontSize:22, cursor:"pointer", boxShadow:"0 4px 12px rgba(0,0,0,0.25)",
            display:"flex", alignItems:"center", justifyContent:"center" }}>✏️</button>
        <button onClick={() => setScanning(true)}
          style={{ width:62, height:62, borderRadius:"50%", background:"#22c55e", color:"#fff",
            border:"none", fontSize:26, cursor:"pointer", boxShadow:"0 4px 16px rgba(34,197,94,0.4)",
            display:"flex", alignItems:"center", justifyContent:"center" }}>📷</button>
      </div>

      {/* Toast */}
      {toast && (
        <div style={{ position:"fixed", bottom:100, left:"50%", transform:"translateX(-50%)",
          background:"#0f172a", color:"#fff", padding:"10px 24px", borderRadius:30,
          fontSize:14, fontWeight:600, zIndex:600, boxShadow:"0 4px 20px rgba(0,0,0,0.3)" }}>
          {toast}
        </div>
      )}

      {scanning   && <BarcodeScanner onDetected={handleScan} onClose={() => setScanning(false)} />}
      {showForm   && <ItemForm initial={editItem} scannedBarcode={!editItem ? scannedBarcode : null}
                      onSave={handleSave} onCancel={() => { setShowForm(false); setEditItem(null); setScanned(null); }} />}
      {viewNutrition && <NutritionPanel nutrition={viewNutrition} onClose={() => setViewNut(null)} />}
    </div>
  );
}
