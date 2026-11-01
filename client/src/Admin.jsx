// Espace du studio (/admin) : connexion, import de musiques, gestion des titres.
import { useCallback, useEffect, useRef, useState } from "react";
import { api, getToken, setToken } from "./api.js";

const fmt = (s) => `${Math.floor((s || 0) / 60)}:${String(Math.floor((s || 0) % 60)).padStart(2, "0")}`;
const fmtBytes = (bytes) => `${(bytes / 1024 ** 3).toFixed(2)} Gio`;

// ======================================================= Connexion
function Login({ onDone }) {
  const [email, setEmail] = useState("");
  const [password, setPassword] = useState("");
  const [error, setError] = useState("");
  const [busy, setBusy] = useState(false);

  async function submit(e) {
    e.preventDefault();
    setBusy(true);
    setError("");
    try {
      await api.login(email, password);
      onDone();
    } catch (err) {
      setError(err.message);
    } finally {
      setBusy(false);
    }
  }

  return (
    <form className="login" onSubmit={submit}>
      <img src="/logo.jpg" alt="RGM" />
      <h1>Espace studio</h1>
      <label>Email
        <input id="email" type="email" value={email} onChange={(e) => setEmail(e.target.value)} autoComplete="username" required />
      </label>
      <label>Mot de passe
        <input id="password" type="password" value={password} onChange={(e) => setPassword(e.target.value)} autoComplete="current-password" required />
      </label>
      {error && <p className="notice" role="alert">{error}</p>}
      <button className="btn primary" disabled={busy}>{busy ? "Connexion..." : "Se connecter"}</button>
    </form>
  );
}

// ======================================================= Ligne d'un titre
function TrackRow({ track, archived, onChange, onArchive, onRestore, onDelete, onError }) {
  const [title, setTitle] = useState(track.title);
  const [album, setAlbum] = useState(track.album);
  const [published, setPublished] = useState(track.published);
  const [confirmingArchive, setConfirmingArchive] = useState(false);
  const [confirmTitle, setConfirmTitle] = useState("");
  const [confirmingDelete, setConfirmingDelete] = useState(false);
  const [deleteTitle, setDeleteTitle] = useState("");
  const [deletePassword, setDeletePassword] = useState("");
  const coverInput = useRef(null);

  useEffect(() => setPublished(track.published), [track.published]);

  async function save(patch) {
    try { onChange(await api.update(track.id, patch)); } catch (e) { setPublished(track.published); onError(e); }
  }
  async function newCover(file) {
    if (!file) return;
    try { onChange(await api.cover(track.id, file)); } catch (e) { onError(e); }
  }
  return (
    <li className="arow">
      <button className="coverbtn" onClick={() => coverInput.current.click()} title="Changer la pochette" aria-label="Changer la pochette">
        {track.cover_url ? <img className="cover" src={track.cover_url} alt="" /> : <div className="cover empty">RGM</div>}
      </button>
      <input ref={coverInput} type="file" accept="image/*" hidden onChange={(e) => newCover(e.target.files[0])} />
      <div className="fields">
        <input value={title} onChange={(e) => setTitle(e.target.value)} aria-label="Titre"
          onBlur={() => title.trim() && title !== track.title && save({ title: title.trim() })} />
        <input value={album} placeholder="Projet ou album" onChange={(e) => setAlbum(e.target.value)} aria-label="Album"
          onBlur={() => album !== track.album && save({ album })} />
      </div>
      <div className="meta">
        <span>{fmt(track.duration)}</span>
        <span>{track.plays} écoute{track.plays > 1 ? "s" : ""}</span>
        <span>{track.rating_count ? `★ ${String(track.rating_avg).replace(".", ",")} (${track.rating_count})` : "Pas de note"}</span>
      </div>
      {archived ? <span className="archive-status">Archivé · fichiers conservés</span> : (
        <label className="switch">
          <input type="checkbox" checked={published}
            onChange={(e) => { setPublished(e.target.checked); save({ published: e.target.checked }); }} />
          <span>{published ? "Publié" : "Brouillon"}</span>
        </label>
      )}
      {archived ? (
        <div className="track-actions">
          <button className="btn" type="button" onClick={() => onRestore(track)}>Restaurer</button>
          <button className="btn danger" type="button" onClick={() => setConfirmingDelete(true)}>Supprimer…</button>
        </div>
      ) : confirmingArchive ? (
        <div className="archive-confirm">
          <label>
            Saisissez « {track.title} » pour confirmer
            <input autoFocus value={confirmTitle} onChange={(e) => setConfirmTitle(e.target.value)} />
          </label>
          <button className="btn danger" type="button" disabled={confirmTitle !== track.title}
            onClick={() => onArchive(track)}>Archiver</button>
          <button className="btn" type="button" onClick={() => { setConfirmingArchive(false); setConfirmTitle(""); }}>Annuler</button>
        </div>
      ) : (
        <button className="btn danger" type="button" onClick={() => setConfirmingArchive(true)}>Archiver</button>
      )}
      {confirmingDelete && archived && (
        <div className="archive-confirm permanent-delete" role="group" aria-label={`Suppression définitive de ${track.title}`}>
          <p>Suppression définitive : le fichier audio, la pochette et les notes seront effacés.</p>
          <label>Saisissez « {track.title} »
            <input autoFocus value={deleteTitle} onChange={(e) => setDeleteTitle(e.target.value)} />
          </label>
          <label>Confirmez votre mot de passe admin
            <input type="password" autoComplete="current-password" value={deletePassword} onChange={(e) => setDeletePassword(e.target.value)} />
          </label>
          <button className="btn danger" type="button" disabled={deleteTitle !== track.title || !deletePassword}
            onClick={() => onDelete(track, deletePassword)}>Supprimer définitivement</button>
          <button className="btn" type="button" onClick={() => { setConfirmingDelete(false); setDeleteTitle(""); setDeletePassword(""); }}>Annuler</button>
        </div>
      )}
    </li>
  );
}

// ======================================================= Page
export default function Admin() {
  const [logged, setLogged] = useState(Boolean(getToken()));
  const [tracks, setTracks] = useState(null);
  const [archivedTracks, setArchivedTracks] = useState([]);
  const [accounts, setAccounts] = useState([]);
  const [currentAdmin, setCurrentAdmin] = useState(null);
  const [storage, setStorage] = useState(null);
  const [section, setSection] = useState("overview");
  const [query, setQuery] = useState("");
  const [message, setMessage] = useState(null);   // { text, ok }
  const [progress, setProgress] = useState(null);   // null = pas d'envoi en cours
  const [over, setOver] = useState(false);
  const [accountEmail, setAccountEmail] = useState("");
  const [accountPassword, setAccountPassword] = useState("");
  const [newPassword, setNewPassword] = useState("");
  const [busy, setBusy] = useState(false);
  const fileInput = useRef(null);

  const logout = useCallback(() => { setToken(null); setLogged(false); setTracks(null); setCurrentAdmin(null); }, []);
  const fail = useCallback((e) => (e.status === 401 ? logout() : setMessage({ text: e.message })), [logout]);

  const load = useCallback(async () => {
    api.adminTracks().then(setTracks).catch(fail);
    api.adminStorage().then(setStorage).catch(fail);
    api.archivedTracks().then(setArchivedTracks).catch(fail);
    api.accounts().then(setAccounts).catch(fail);
    api.me().then(setCurrentAdmin).catch(fail);
  }, [fail]);

  useEffect(() => { if (logged) load(); }, [logged, load]);

  async function upload(fileList) {
    const files = [...fileList];
    if (!files.length) return;
    setMessage(null);
    setProgress(0);
    try {
      const res = await api.upload(files, setProgress);
      if (res.errors?.length) setMessage({ text: res.errors.map((e) => `${e.file} : ${e.error}`).join(" · ") });
      else setMessage({ ok: true, text: `${res.created.length} titre${res.created.length > 1 ? "s" : ""} importé${res.created.length > 1 ? "s" : ""}.` });
      load();
    } catch (e) {
      fail(e);
    } finally {
      setProgress(null);
      if (fileInput.current) fileInput.current.value = "";
    }
  }

  async function archiveTrack(track) {
    try {
      await api.archive(track.id);
      setTracks((all) => all.filter((item) => item.id !== track.id));
      setArchivedTracks((all) => [{ ...track, archivedAt: new Date().toISOString() }, ...all]);
      setMessage({ ok: true, text: `« ${track.title} » a été archivé. Vous pouvez le restaurer à tout moment.` });
    } catch (e) { fail(e); }
  }

  async function restoreTrack(track) {
    try {
      const restored = await api.restore(track.id);
      setArchivedTracks((all) => all.filter((item) => item.id !== track.id));
      setTracks((all) => [restored, ...all]);
      setMessage({ ok: true, text: `« ${track.title} » a été restauré.` });
    } catch (e) { fail(e); }
  }

  async function deleteTrack(track, password) {
    try {
      await api.permanentlyDelete(track.id, track.title, password);
      setArchivedTracks((all) => all.filter((item) => item.id !== track.id));
      setMessage({ ok: true, text: `« ${track.title} » et ses fichiers ont été supprimés définitivement.` });
    } catch (e) { fail(e); }
  }

  async function createAccount(e) {
    e.preventDefault();
    setBusy(true);
    try {
      const account = await api.createAccount(accountEmail, accountPassword);
      setAccounts((all) => [...all, account].sort((a, b) => a.id - b.id));
      setAccountEmail("");
      setAccountPassword("");
      setMessage({ ok: true, text: `Le compte ${account.email} a été créé.` });
    } catch (e) { fail(e); } finally { setBusy(false); }
  }

  async function deactivateAccount(account) {
    if (!window.confirm(`Désactiver le compte ${account.email} ? Il ne pourra plus se connecter.`)) return;
    try {
      const updated = await api.updateAccount(account.id, { isActive: false });
      setAccounts((all) => all.map((item) => item.id === updated.id ? updated : item));
      setMessage({ ok: true, text: `Le compte ${account.email} a été désactivé.` });
    } catch (e) { fail(e); }
  }

  async function changeOwnPassword(e) {
    e.preventDefault();
    if (!currentAdmin) return;
    setBusy(true);
    try {
      await api.updateAccount(currentAdmin.id, { password: newPassword });
      setNewPassword("");
      setMessage({ ok: true, text: "Votre mot de passe a été modifié." });
    } catch (e) { fail(e); } finally { setBusy(false); }
  }

  const visibleTracks = (tracks || []).filter((track) =>
    `${track.title} ${track.artist} ${track.album}`.toLowerCase().includes(query.trim().toLowerCase()));

  if (!logged) return <div className="admin"><Login onDone={() => setLogged(true)} /></div>;

  return (
    <div className="admin">
      <header className="admin-top">
        <a className="admin-brand" href="/admin"><img src="/logo.jpg" alt="" /><span>RGM<small>STUDIO</small></span></a>
        <nav className="admin-nav" aria-label="Navigation admin">
          {[["overview", "Vue d’ensemble"], ["tracks", "Bibliothèque"], ["archive", "Archives"], ["accounts", "Comptes"]].map(([id, label]) => (
            <button type="button" key={id} className={section === id ? "active" : ""} onClick={() => { setSection(id); setMessage(null); }}>{label}</button>
          ))}
        </nav>
        <div className="admin-actions">
          <span className="admin-identity">{currentAdmin?.email}</span>
          <a href="/" className="btn">Voir le site</a>
          <button className="btn" type="button" onClick={logout}>Déconnexion</button>
        </div>
      </header>

      <main className="admin-main">
        <section className="admin-heading">
          <div><p className="eyebrow">ESPACE STUDIO</p><h1>{section === "overview" ? "Vue d’ensemble" : section === "tracks" ? "Bibliothèque" : section === "archive" ? "Archives" : "Comptes administrateur"}</h1></div>
          <span className="admin-live"><i /> Service opérationnel</span>
        </section>

        {message && <p className={`notice ${message.ok ? "ok" : ""}`} role={message.ok ? "status" : "alert"}>{message.text}</p>}

        {section === "overview" && (
          <>
            <div className="admin-stats">
              <article><span>Titres actifs</span><strong>{tracks?.length ?? "—"}</strong><small>Dans la bibliothèque</small></article>
              <article><span>En archive</span><strong>{archivedTracks.length}</strong><small>Restaurables à tout moment</small></article>
              <article><span>Comptes actifs</span><strong>{accounts.filter((a) => a.isActive).length}</strong><small>Accès studio</small></article>
              <article><span>Stockage médias</span><strong>{storage?.tracked ? fmtBytes(storage.usedBytes) : "—"}</strong><small>Fichiers audio et pochettes</small></article>
            </div>
            {storage?.tracked && <div className={`storage-card ${storage.warning ? "warning" : ""}`} role={storage.warning ? "alert" : "status"}>
              <div><strong>Stockage TiDB</strong><span>{fmtBytes(storage.usedBytes)} sur {fmtBytes(storage.limitBytes)} réservés</span></div>
              <div className="storage-meter"><span style={{ width: `${Math.min(100, storage.usedBytes / storage.limitBytes * 100)}%` }} /></div>
              <p>{storage.warning ? "L’espace approche de la limite. Aucun titre n’est supprimé automatiquement ; les nouveaux imports seront refusés si la réserve est atteinte." : "Les morceaux sont conservés. Aucun nettoyage automatique n’est effectué."}</p>
            </div>}
            <section className="admin-panel">
              <div className="panel-title"><div><h2>Importer des morceaux</h2><p>Ajoutez des fichiers audio à votre bibliothèque.</p></div></div>
              <label className={`drop ${over ? "over" : ""} ${storage?.importBlocked ? "disabled" : ""}`}
                onDragOver={(e) => { e.preventDefault(); if (!storage?.importBlocked) setOver(true); }}
                onDragLeave={() => setOver(false)}
                onDrop={(e) => { e.preventDefault(); setOver(false); if (!storage?.importBlocked) upload(e.dataTransfer.files); }}>
                <span className="drop-icon" aria-hidden="true">↑</span><strong>{storage?.importBlocked ? "Espace presque plein" : "Glissez vos fichiers ici"}</strong>
                <span>ou sélectionnez sur cet appareil · MP3, WAV, FLAC, M4A, AAC, OGG · 20 Mo max.</span>
                <input ref={fileInput} type="file" accept="audio/*" multiple hidden disabled={Boolean(storage?.importBlocked)} onChange={(e) => upload(e.target.files)} />
                {progress !== null && <div className="progress" role="progressbar" aria-valuenow={Math.round(progress * 100)}><div style={{ width: `${progress * 100}%` }} /><small>{progress >= 1 ? "Enregistrement..." : `${Math.round(progress * 100)} %`}</small></div>}
              </label>
            </section>
            <section className="admin-panel">
              <div className="panel-title"><div><h2>Derniers morceaux</h2><p>Modifiez les informations ou gérez la publication.</p></div><button className="btn" type="button" onClick={() => setSection("tracks")}>Tout voir</button></div>
              <TrackList tracks={(tracks || []).slice(0, 5)} query="" onChange={(u) => setTracks((all) => all.map((x) => x.id === u.id ? u : x))}
                  onArchive={archiveTrack} onRestore={restoreTrack} onDelete={deleteTrack} onError={fail} />
            </section>
          </>
        )}

        {(section === "tracks" || section === "archive") && (
          <section className="admin-panel">
            {section === "tracks" && <label className="admin-search"><span aria-hidden="true">⌕</span><input type="search" value={query} onChange={(e) => setQuery(e.target.value)} placeholder="Rechercher un morceau…" aria-label="Rechercher un morceau" /></label>}
            <div className="panel-title"><div><h2>{section === "tracks" ? "Tous les morceaux" : "Morceaux archivés"}</h2><p>{section === "tracks" ? `${visibleTracks.length} élément${visibleTracks.length === 1 ? "" : "s"} · archiver masque sans effacer` : "Les fichiers sont conservés ; restaurez un titre en un clic."}</p></div></div>
            <TrackList tracks={section === "tracks" ? visibleTracks : archivedTracks} archived={section === "archive"} query={query}
              onChange={(u) => setTracks((all) => all.map((x) => x.id === u.id ? u : x))}
              onArchive={archiveTrack} onRestore={restoreTrack} onDelete={deleteTrack} onError={fail} />
          </section>
        )}

        {section === "accounts" && (
          <div className="account-layout">
            <section className="admin-panel">
              <div className="panel-title"><div><h2>Ajouter un administrateur</h2><p>Limite de 10 comptes. Mot de passe d’au moins 12 caractères.</p></div></div>
              <form className="account-form" onSubmit={createAccount}>
                <label>Adresse e-mail<input type="email" autoComplete="email" value={accountEmail} onChange={(e) => setAccountEmail(e.target.value)} required /></label>
                <label>Mot de passe temporaire<input type="password" autoComplete="new-password" minLength={12} value={accountPassword} onChange={(e) => setAccountPassword(e.target.value)} required /></label>
                <button className="btn primary" disabled={busy}>Créer le compte</button>
              </form>
            </section>
            <section className="admin-panel">
              <div className="panel-title"><div><h2>Accès administrateurs</h2><p>Désactivez les comptes qui ne doivent plus accéder au studio.</p></div></div>
              <ul className="account-list">{accounts.map((account) => <li key={account.id}>
                <span className="account-avatar">{account.email[0].toUpperCase()}</span><div><strong>{account.email}</strong><small>{account.id === currentAdmin?.id ? "Votre compte" : account.isActive ? "Accès actif" : "Désactivé"}</small></div>
                {account.isActive && account.id !== currentAdmin?.id && <button className="btn" type="button" onClick={() => deactivateAccount(account)}>Désactiver</button>}
              </li>)}</ul>
            </section>
            <section className="admin-panel">
              <div className="panel-title"><div><h2>Changer mon mot de passe</h2><p>Choisissez une phrase secrète longue et unique.</p></div></div>
              <form className="account-form" onSubmit={changeOwnPassword}>
                <label>Nouveau mot de passe<input type="password" autoComplete="new-password" minLength={12} value={newPassword} onChange={(e) => setNewPassword(e.target.value)} required /></label>
                <button className="btn" disabled={busy}>Mettre à jour</button>
              </form>
            </section>
          </div>
        )}
      </main>
    </div>
  );
}

function TrackList({ tracks, archived = false, onChange, onArchive, onRestore, onDelete, onError }) {
  if (!tracks.length) return <p className="empty-admin">{archived ? "Aucun morceau archivé." : "Aucun morceau ici. Importez un titre pour commencer."}</p>;
  return <ul className="alist">{tracks.map((track) => <TrackRow key={track.id} track={track} archived={archived}
    onChange={onChange} onArchive={onArchive} onRestore={onRestore} onDelete={onDelete} onError={onError} />)}</ul>;
}
