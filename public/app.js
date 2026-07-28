// Anchour Voice Checker — frontend. Posts the pasted copy to /api/check and
// renders the scored result. All model text is inserted via textContent, never
// innerHTML, so nothing the model returns can inject markup.

const MAX_CHARS = 8000;

const form = document.getElementById("checker");
const textarea = document.getElementById("copy");
const counter = document.getElementById("counter");
const button = document.getElementById("submit");
const errorEl = document.getElementById("error");
const results = document.getElementById("results");

// --- helpers ---------------------------------------------------------------

function el(tag, className, text) {
  const node = document.createElement(tag);
  if (className) node.className = className;
  if (text != null) node.textContent = text;
  return node;
}

function updateCounter() {
  const n = textarea.value.length;
  counter.textContent = `${n} / ${MAX_CHARS}`;
  counter.classList.toggle("is-near", n > MAX_CHARS * 0.9);
}

function setLoading(loading) {
  document.body.classList.toggle("is-loading", loading);
  button.disabled = loading;
  button.textContent = loading ? "Reading the voice…" : "Check the voice";
}

function showError(message) {
  errorEl.textContent = message;
  errorEl.hidden = false;
}

function clearError() {
  errorEl.hidden = true;
  errorEl.textContent = "";
}

// --- rendering -------------------------------------------------------------

function meter(score, applicable) {
  const wrap = el("span", "meter");
  wrap.setAttribute("role", "img");
  wrap.setAttribute(
    "aria-label",
    applicable === false ? "not applicable" : `score ${score} of 5`,
  );
  for (let i = 1; i <= 5; i++) {
    const seg = el("span", "seg");
    if (applicable !== false && i <= score) seg.classList.add("on");
    wrap.appendChild(seg);
  }
  return wrap;
}

function dimensionRow(d) {
  const na = d.applicable === false;
  const li = el("li", na ? "dim na" : "dim");

  const head = el("div", "dim-head");
  head.appendChild(el("span", "dim-name", d.name));
  head.appendChild(meter(d.score, d.applicable));
  head.appendChild(el("span", "dim-score", na ? "N/A" : String(d.score)));

  li.appendChild(head);
  if (d.reasoning) li.appendChild(el("p", "dim-reason", d.reasoning));
  return li;
}

function render(data) {
  results.replaceChildren();

  // Verdict hero
  const verdict = el("div", data.pass ? "verdict is-pass" : "verdict is-fail");

  const score = el("div", "verdict-score");
  score.appendChild(el("span", "num", String(data.overall_score)));
  score.appendChild(el("span", "denom", "/5"));
  verdict.appendChild(score);

  const meta = el("div", "verdict-meta");
  meta.appendChild(el("span", data.pass ? "pill pass" : "pill fail", data.pass ? "Pass" : "Fail"));
  const count = data.applicable_count ?? data.dimensions.length;
  meta.appendChild(
    el(
      "p",
      "verdict-sub",
      `Average of ${count} applicable ${count === 1 ? "dimension" : "dimensions"}`,
    ),
  );
  verdict.appendChild(meta);
  results.appendChild(verdict);

  // Dimension rows
  const list = el("ol", "dims");
  for (const d of data.dimensions) list.appendChild(dimensionRow(d));
  results.appendChild(list);

  // Rewrites
  if (Array.isArray(data.rewrites) && data.rewrites.length) {
    const box = el("div", "rewrites");
    box.appendChild(el("h2", null, "In-voice rewrites"));
    const ol = el("ol");
    for (const r of data.rewrites) ol.appendChild(el("li", null, r));
    box.appendChild(ol);
    results.appendChild(box);
  }

  results.hidden = false;
}

// --- submit ----------------------------------------------------------------

async function check() {
  const text = textarea.value.trim();
  clearError();
  if (!text) {
    showError("Paste some copy to check first.");
    return;
  }

  setLoading(true);
  try {
    const res = await fetch("/api/check", {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ text }),
    });

    let data = null;
    try {
      data = await res.json();
    } catch {
      /* non-JSON response handled below */
    }

    if (!res.ok || !data || data.error) {
      showError((data && data.error) || `Request failed (HTTP ${res.status}).`);
      return;
    }

    render(data);
    results.scrollIntoView({ behavior: "smooth", block: "start" });
  } catch (err) {
    showError(`Couldn’t reach the checker: ${err.message}`);
  } finally {
    setLoading(false);
  }
}

form.addEventListener("submit", (e) => {
  e.preventDefault();
  check();
});

// Cmd/Ctrl+Enter submits from the textarea.
textarea.addEventListener("keydown", (e) => {
  if ((e.metaKey || e.ctrlKey) && e.key === "Enter") {
    e.preventDefault();
    check();
  }
});

textarea.addEventListener("input", updateCounter);
updateCounter();
