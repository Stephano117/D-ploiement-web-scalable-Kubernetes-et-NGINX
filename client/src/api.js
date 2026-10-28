// Tous les appels vers le backend sont ici.
const TOKEN_KEY = "rgm_token";
export const getToken = () => localStorage.getItem(TOKEN_KEY);
export const setToken = (t) => (t ? localStorage.setItem(TOKEN_KEY, t) : localStorage.removeItem(TOKEN_KEY));

async function request(path, options = {}, auth = false) {
  const headers = { ...(options.headers || {}) };
  if (auth && getToken()) headers.Authorization = `Bearer ${getToken()}`;
  const res = await fetch(path, { ...options, headers });
  if (!res.ok) {
    let message = "Une erreur est survenue.";
    try {
      const data = await res.json();
      if (typeof data.detail === "string") message = data.detail;
    } catch { /* réponse sans JSON */ }
    const err = new Error(message);
    err.status = res.status;
    throw err;
  }
  return res.json();
}

const json = (method, body) => ({
  method,
  headers: { "Content-Type": "application/json" },
  body: JSON.stringify(body),
});

export const api = {
  // ---- Site public
  tracks: () => request("/api/tracks"),
  play: (id) => request(`/api/tracks/${id}/play`, { method: "POST" }),
  rate: (id, value) => request(`/api/tracks/${id}/rate`, json("POST", { value })),

  // ---- Espace admin
  async login(email, password) {
    const data = await request("/api/admin/login", json("POST", { email, password }));
    setToken(data.access_token);
  },
  adminTracks: () => request("/api/admin/tracks", {}, true),
  update: (id, patch) => request(`/api/admin/tracks/${id}`, json("PATCH", patch), true),
  remove: (id) => request(`/api/admin/tracks/${id}`, { method: "DELETE" }, true),
  cover(id, file) {
    const body = new FormData();
    body.append("file", file);
    return request(`/api/admin/tracks/${id}/cover`, { method: "POST", body }, true);
  },
  // Envoi de fichiers avec barre de progression (fetch ne sait pas la fournir).
  upload(files, onProgress) {
    return new Promise((resolve, reject) => {
      const body = new FormData();
      files.forEach((f) => body.append("files", f));
      const xhr = new XMLHttpRequest();
      xhr.open("POST", "/api/admin/tracks");
      xhr.setRequestHeader("Authorization", `Bearer ${getToken()}`);
      xhr.upload.onprogress = (e) => e.lengthComputable && onProgress(e.loaded / e.total);
      xhr.onerror = () => reject(new Error("Connexion impossible avec le serveur."));
      xhr.onload = () => {
        let data = {};
        try { data = JSON.parse(xhr.responseText); } catch { /* pas de JSON */ }
        if (xhr.status >= 200 && xhr.status < 300) return resolve(data);
        const err = new Error(typeof data.detail === "string" ? data.detail : "Envoi impossible.");
        err.status = xhr.status;
        reject(err);
      };
      xhr.send(body);
    });
  },
};
