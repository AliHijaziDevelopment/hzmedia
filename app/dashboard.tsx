"use client";

import { FormEvent, useCallback, useEffect, useMemo, useRef, useState } from "react";
import { useAuth } from "./auth-provider";

type Me = { id: string; email: string; name: string; role: "super_admin" | "user"; companyIds: string[] };
type Company = { _id: string; name: string; slug: string; memberCount: number; albumCount: number; storageBytes: number; createdAt: string };
type Album = { _id: string; companyId: string; name: string; itemCount: number; createdAt: string; updatedAt: string };
type Media = { _id: string; filename: string; mimeType: string; kind: "image" | "video"; bytes: number; url: string };
type WorkspaceUser = { _id: string; username: string; firstName: string; lastName: string; email: string; name: string; companyIds: string[]; status: string; createdAt: string };
type Modal = "company" | "album" | "addUser" | "assignUser" | null;
type NavItem = "Overview" | "Companies" | "Members" | "Activity";
type ActivityItem = { _id: string; action: "company.created" | "user.created" | "user.assigned" | "album.created" | "media.uploaded"; targetType: "company" | "user" | "album" | "media"; targetName: string; detail: string; companyId?: string; actor: { name: string; email: string }; createdAt: string };
type UploadStatus = "preparing" | "uploading" | "processing" | "complete" | "error";
type UploadTask = { id: string; filename: string; progress: number; status: UploadStatus; error?: string };

const nav: NavItem[] = ["Overview", "Companies", "Members", "Activity"];

export default function Dashboard() {
  const auth = useAuth();
  const [me, setMe] = useState<Me | null>(null);
  const [companies, setCompanies] = useState<Company[]>([]);
  const [users, setUsers] = useState<WorkspaceUser[]>([]);
  const [albums, setAlbums] = useState<Album[]>([]);
  const [activity, setActivity] = useState<ActivityItem[]>([]);
  const [activeNav, setActiveNav] = useState<NavItem>("Overview");
  const [selectedCompany, setSelectedCompany] = useState("all");
  const [search, setSearch] = useState("");
  const [modal, setModal] = useState<Modal>(null);
  const [assigningUserId, setAssigningUserId] = useState("");
  const [openAlbum, setOpenAlbum] = useState<Album | null>(null);
  const [media, setMedia] = useState<Media[]>([]);
  const [uploads, setUploads] = useState<UploadTask[]>([]);
  const [loading, setLoading] = useState(true);
  const [uploading, setUploading] = useState(false);
  const [error, setError] = useState("");
  const [toast, setToast] = useState("");
  const liveSocket = useRef<WebSocket | null>(null);

  const api = useCallback(async <T,>(path: string, init?: RequestInit): Promise<T> => {
    const response = await auth.authorizedFetch(path, init);
    const body = await response.json().catch(() => ({}));
    if (!response.ok) throw new Error((body as { error?: string }).error ?? "Request failed");
    return body as T;
  }, [auth]);

  const loadCompanies = useCallback(async () => {
    const result = await api<{ companies: Company[] }>("/api/companies");
    setCompanies(result.companies);
    return result.companies;
  }, [api]);

  const loadAlbums = useCallback(async (companyList: Company[], companyId: string) => {
    const targets = companyId === "all" ? companyList : companyList.filter((company) => company._id === companyId);
    const results = await Promise.all(targets.map((company) => api<{ albums: Album[] }>(`/api/companies/${company._id}/albums`)));
    setAlbums(results.flatMap((result) => result.albums));
  }, [api]);

  const loadUsers = useCallback(async () => {
    if (!auth.isSuperAdmin) return [];
    const result = await api<{ users: WorkspaceUser[] }>("/api/users");
    setUsers(result.users);
    return result.users;
  }, [api, auth.isSuperAdmin]);

  const loadActivity = useCallback(async () => {
    const result = await api<{ activity: ActivityItem[] }>("/api/activity");
    setActivity(result.activity);
    return result.activity;
  }, [api]);

  useEffect(() => {
    let active = true;
    (async () => {
      try {
        setLoading(true);
        const [profile, companyList] = await Promise.all([api<Me>("/api/me"), loadCompanies(), loadUsers(), loadActivity()]);
        if (!active) return;
        setMe(profile);
        await loadAlbums(companyList, "all");
      } catch (reason) { if (active) setError(reason instanceof Error ? reason.message : "Could not load workspace"); }
      finally { if (active) setLoading(false); }
    })();
    return () => { active = false; };
  }, [api, loadActivity, loadAlbums, loadCompanies, loadUsers]);

  useEffect(() => {
    if (!loading) loadAlbums(companies, selectedCompany).catch((reason) => setError(reason.message));
  }, [companies, loadAlbums, loading, selectedCompany]);

  useEffect(() => {
    let stopped = false;
    let retry: number | undefined;
    function connect() {
      const url = new URL(auth.apiBaseUrl);
      url.protocol = url.protocol === "https:" ? "wss:" : "ws:";
      url.pathname = "/live";
      url.search = "";
      const socket = new WebSocket(url);
      liveSocket.current = socket;
      socket.onmessage = (event) => {
        try {
          const message = JSON.parse(String(event.data)) as { type?: string; uploadId?: string; filename?: string; progress?: number; status?: UploadStatus };
          if (!message.uploadId || (message.type !== "upload:progress" && message.type !== "upload:complete")) return;
          const status = message.type === "upload:complete" ? "complete" : message.status ?? "uploading";
          setUploads((current) => {
            const existing = current.find((item) => item.id === message.uploadId);
            if (existing) return current.map((item) => item.id === message.uploadId ? { ...item, status, progress: message.type === "upload:complete" ? 100 : message.progress ?? item.progress } : item);
            if (!message.filename) return current;
            return [{ id: message.uploadId!, filename: message.filename, status, progress: message.progress ?? 0 }, ...current].slice(0, 20);
          });
        } catch { /* Ignore malformed live updates. */ }
      };
      socket.onclose = () => { if (!stopped) retry = window.setTimeout(connect, 2_500); };
    }
    connect();
    return () => { stopped = true; if (retry) window.clearTimeout(retry); liveSocket.current?.close(); };
  }, [auth.apiBaseUrl]);

  const normalizedSearch = search.trim().toLowerCase();
  const selectedCompanyRecord = companies.find((company) => company._id === selectedCompany);
  const visibleAlbums = useMemo(() => albums.filter((album) => {
    const companyName = companies.find((company) => company._id === album.companyId)?.name ?? "";
    return !normalizedSearch || album.name.toLowerCase().includes(normalizedSearch) || companyName.toLowerCase().includes(normalizedSearch);
  }), [albums, companies, normalizedSearch]);
  const visibleCompanies = useMemo(() => companies.filter((company) => !normalizedSearch || company.name.toLowerCase().includes(normalizedSearch)), [companies, normalizedSearch]);
  const visibleUsers = useMemo(() => users.filter((user) => {
    const matchesCompany = selectedCompany === "all" || user.companyIds.includes(selectedCompany);
    const identity = `${user.name} ${user.username} ${user.email}`.toLowerCase();
    return matchesCompany && (!normalizedSearch || identity.includes(normalizedSearch));
  }), [normalizedSearch, selectedCompany, users]);
  const albumCount = companies.reduce((sum, company) => sum + company.albumCount, 0);
  const memberCount = companies.reduce((sum, company) => sum + company.memberCount, 0);
  const storageBytes = companies.reduce((sum, company) => sum + company.storageBytes, 0);
  const initials = (me?.name || auth.name).split(/\s+/).slice(0, 2).map((part) => part[0]).join("").toUpperCase();
  const visibleActivity = useMemo(() => activity.filter((item) => {
    const matchesCompany = selectedCompany === "all" || item.companyId === selectedCompany;
    const content = `${item.targetName} ${item.detail} ${item.actor.name} ${item.actor.email}`.toLowerCase();
    return matchesCompany && (!normalizedSearch || content.includes(normalizedSearch));
  }), [activity, normalizedSearch, selectedCompany]);
  const unassignedUsers = users.filter((user) => !user.companyIds.length).length;
  const pageTitle: Record<NavItem, string> = {
    Overview: `Welcome, ${(me?.name || auth.name).split(" ")[0]}.`,
    Companies: selectedCompanyRecord?.name ?? "Companies",
    Members: "Members",
    Activity: "Activity",
  };
  const searchPlaceholder: Record<NavItem, string> = { Overview: "Search albums…", Companies: "Search companies or albums…", Members: "Search members…", Activity: "Search activity…" };

  function flash(message: string) { setToast(message); window.setTimeout(() => setToast(""), 2600); }
  async function refresh() { const companyList = await loadCompanies(); await Promise.all([loadAlbums(companyList, selectedCompany), loadUsers(), loadActivity()]); }
  function navigate(item: NavItem) { setActiveNav(item); setSearch(""); }
  function chooseCompany(companyId: string) { setSelectedCompany(companyId); setActiveNav("Companies"); setSearch(""); }
  function publishUpload(task: UploadTask) {
    setUploads((current) => current.map((item) => item.id === task.id ? task : item));
    if (liveSocket.current?.readyState === WebSocket.OPEN) liveSocket.current.send(JSON.stringify({ type: "upload:progress", uploadId: task.id, filename: task.filename, progress: task.progress, status: task.status }));
  }
  function downloadAlbum(album: Album) {
    const link = document.createElement("a");
    link.href = `${auth.apiBaseUrl}/api/albums/${album._id}/download`;
    link.download = `${album.name}.zip`;
    link.rel = "noopener";
    document.body.appendChild(link);
    link.click();
    link.remove();
    flash("Download started");
  }

  async function createCompany(event: FormEvent<HTMLFormElement>) {
    event.preventDefault();
    try { const data = new FormData(event.currentTarget); await api("/api/companies", { method: "POST", body: JSON.stringify({ name: data.get("name") }) }); setModal(null); await refresh(); flash("Company created"); }
    catch (reason) { setError(reason instanceof Error ? reason.message : "Could not create company"); }
  }

  async function createAlbum(event: FormEvent<HTMLFormElement>) {
    event.preventDefault();
    try { const data = new FormData(event.currentTarget); const companyId = String(data.get("companyId")); await api(`/api/companies/${companyId}/albums`, { method: "POST", body: JSON.stringify({ name: data.get("name") }) }); setModal(null); await refresh(); flash("Album created"); }
    catch (reason) { setError(reason instanceof Error ? reason.message : "Could not create album"); }
  }

  async function createUser(event: FormEvent<HTMLFormElement>) {
    event.preventDefault();
    try {
      const data = new FormData(event.currentTarget);
      await api("/api/users", { method: "POST", body: JSON.stringify({ firstName: data.get("firstName"), lastName: data.get("lastName"), username: data.get("username"), email: data.get("email"), password: data.get("password") }) });
      setModal(null); await refresh(); flash("User added");
    } catch (reason) { setError(reason instanceof Error ? reason.message : "Could not create user"); }
  }

  async function assignUser(event: FormEvent<HTMLFormElement>) {
    event.preventDefault();
    try {
      const data = new FormData(event.currentTarget);
      const companyId = String(data.get("companyId"));
      await api(`/api/companies/${companyId}/members`, { method: "POST", body: JSON.stringify({ userId: data.get("userId") }) });
      setModal(null); await refresh(); flash("User assigned to company");
    } catch (reason) { setError(reason instanceof Error ? reason.message : "Could not assign user"); }
  }

  async function showAlbum(album: Album) {
    try { setOpenAlbum(album); setMedia([]); const result = await api<{ media: Media[] }>(`/api/albums/${album._id}/media`); setMedia(result.media); }
    catch (reason) { setError(reason instanceof Error ? reason.message : "Could not open album"); }
  }

  async function uploadFiles(files: FileList | null) {
    if (!files || !openAlbum) return;
    const album = openAlbum;
    const selected = Array.from(files);
    const tasks = selected.map((file) => ({ file, task: { id: createUploadId(), filename: file.name, progress: 0, status: "preparing" as UploadStatus } }));
    setUploads((current) => [...tasks.map((item) => item.task), ...current].slice(0, 20));
    setOpenAlbum(null);
    setUploading(true);
    flash(`${selected.length} upload${selected.length === 1 ? "" : "s"} started`);
    const queue = [...tasks];
    async function runNext() {
      while (queue.length) {
        const item = queue.shift();
        if (!item) return;
        const { file, task } = item;
        try {
          if (!file.type.startsWith("image/") && !file.type.startsWith("video/")) throw new Error("Only images and videos are supported");
          publishUpload(task);
          const created = await api<{ mediaId: string; uploadUrl: string }>(`/api/albums/${album._id}/uploads`, { method: "POST", body: JSON.stringify({ filename: file.name, mimeType: file.type, bytes: file.size }) });
          let lastProgress = 0;
          await putFile(created.uploadUrl, file, (value) => {
            const progress = Math.min(95, Math.max(1, Math.round(value * 0.95)));
            if (progress >= lastProgress + 2 || progress === 95) { lastProgress = progress; publishUpload({ ...task, progress, status: "uploading" }); }
          });
          publishUpload({ ...task, progress: 98, status: "processing" });
          await api(`/api/media/${created.mediaId}/complete`, { method: "POST", body: JSON.stringify({ uploadId: task.id }) });
          publishUpload({ ...task, progress: 100, status: "complete" });
        } catch (reason) {
          const message = reason instanceof Error ? reason.message : "Upload failed";
          publishUpload({ ...task, progress: 0, status: "error", error: message });
        }
      }
    }
    await Promise.all(Array.from({ length: Math.min(2, queue.length) }, () => runNext()));
    setUploading(false);
    await refresh().catch(() => undefined);
  }

  return <main className="app-shell">
    <aside className="sidebar">
      <div className="brand"><span className="brand-mark">HZ</span><span>HZ Media</span></div>
      <nav aria-label="Main navigation">
        <p className="nav-label">Workspace</p>
        {nav.map((item) => <button key={item} className={`nav-item ${activeNav === item ? "active" : ""}`} aria-current={activeNav === item ? "page" : undefined} onClick={() => navigate(item)}><span className={`nav-icon icon-${item.toLowerCase()}`} />{item}</button>)}
        <p className="nav-label company-label">Companies</p>
        <button className={`nav-item ${activeNav === "Companies" && selectedCompany === "all" ? "active-company" : ""}`} onClick={() => chooseCompany("all")}><span className="all-company-mark">⌘</span>All companies</button>
        {companies.map((company) => <button key={company._id} className={`nav-item company-item ${activeNav === "Companies" && selectedCompany === company._id ? "active-company" : ""}`} onClick={() => chooseCompany(company._id)}><span className="company-dot blue">{companyInitials(company.name)}</span><span className="company-name">{company.name}</span></button>)}
      </nav>
      <div className="sidebar-bottom"><div className="storage-card"><span><b>Storage</b><small>{formatBytes(storageBytes)} used</small></span><i><em style={{ width: storageBytes ? "14%" : "0%" }} /></i></div><button className="profile-card" onClick={auth.logout}><span className="avatar">{initials}</span><span><b>{me?.name || auth.name}</b><small>{me?.role === "super_admin" ? "Super admin" : "User"} · Sign out</small></span></button></div>
    </aside>

    <section className="workspace">
      <header className="topbar"><span className="mobile-brand"><span className="brand-mark">HZ</span></span><label className="search-field"><span /><input value={search} onChange={(event) => setSearch(event.target.value)} placeholder={searchPlaceholder[activeNav]} aria-label={searchPlaceholder[activeNav]} /></label><div className="top-actions">{(activeNav === "Overview" || activeNav === "Companies") && <button className="primary-action" disabled={!companies.length} onClick={() => setModal("album")}><span>＋</span> New album</button>}</div></header>
      <div className="mobile-nav" aria-label="Mobile navigation">{nav.map((item) => <button key={item} className={activeNav === item ? "active" : ""} onClick={() => navigate(item)}>{item}</button>)}</div>
      <div className="content">
        {error && <div className="error-banner"><span>{error}</span><button onClick={() => setError("")} aria-label="Dismiss error">×</button></div>}
        <div className="page-heading"><div><p className="eyebrow">{activeNav}</p><h1>{pageTitle[activeNav]}</h1></div>
          {me?.role === "super_admin" && <div className="heading-actions">
            {activeNav === "Overview" && <><button className="secondary-button" onClick={() => setModal("addUser")}>Add user</button><button className="secondary-button dark" onClick={() => setModal("company")}>Create company</button></>}
            {activeNav === "Companies" && <><button className="secondary-button" disabled={!companies.length} onClick={() => setModal("album")}>New album</button><button className="secondary-button dark" onClick={() => setModal("company")}>Create company</button></>}
            {activeNav === "Members" && <><button className="secondary-button" disabled={!companies.length || !users.length} onClick={() => { setAssigningUserId(""); setModal("assignUser"); }}>Assign user</button><button className="secondary-button dark" onClick={() => setModal("addUser")}>Add user</button></>}
          </div>}
        </div>

        {loading ? <div className="empty-state page-loader"><span className="auth-spinner" /><p>Loading your workspace…</p></div> : <>
          {activeNav === "Overview" && <>
            <section className="stats-grid"><Stat label="Companies" value={companies.length} icon="⌂" tone="companies-icon" /><Stat label="Memberships" value={memberCount} icon="♙" tone="members-icon" /><Stat label="Albums" value={albumCount} icon="▱" tone="albums-icon" /><Stat label="Storage" value={formatBytes(storageBytes)} icon="◫" tone="assets-icon" /></section>
            <section className="recent-section"><SectionHeading title={selectedCompanyRecord ? `${selectedCompanyRecord.name} albums` : "Recent albums"} detail={`${visibleAlbums.length} album${visibleAlbums.length === 1 ? "" : "s"}`} action={<button className="text-button" onClick={() => navigate("Companies")}>View companies <span>→</span></button>} />
              <AlbumCollection albums={visibleAlbums.slice(0, 5)} companies={companies} onOpen={showAlbum} onDownload={downloadAlbum} onNew={() => setModal("album")} canCreate={!!companies.length} emptyMessage={companies.length ? "Create the first album for this company." : me?.role === "super_admin" ? "Create a company to begin." : "Ask a super admin to assign you to a company."} />
            </section>
            {!!companies.length && <section className="companies-section"><SectionHeading title="Company snapshot" detail={`${companies.length} compan${companies.length === 1 ? "y" : "ies"}`} action={<button className="text-button" onClick={() => navigate("Companies")}>Manage companies <span>→</span></button>} /><CompanyRows companies={companies.slice(0, 4)} onSelect={chooseCompany} /></section>}
          </>}

          {activeNav === "Companies" && <section className="page-section">
            {selectedCompanyRecord ? <>
              <div className="company-focus"><span className="company-logo blue">{companyInitials(selectedCompanyRecord.name)}</span><div><b>{selectedCompanyRecord.name}</b></div><Metric label="Members" value={selectedCompanyRecord.memberCount} /><Metric label="Albums" value={selectedCompanyRecord.albumCount} /><Metric label="Storage" value={formatBytes(selectedCompanyRecord.storageBytes)} /></div>
              <SectionHeading title="Company albums" detail={`${visibleAlbums.length} album${visibleAlbums.length === 1 ? "" : "s"}`} action={<button className="text-button" onClick={() => chooseCompany("all")}>View all companies <span>→</span></button>} />
              <AlbumCollection albums={visibleAlbums} companies={companies} onOpen={showAlbum} onDownload={downloadAlbum} onNew={() => setModal("album")} canCreate emptyMessage="Create the first album for this company." />
            </> : <>
              <SectionHeading title="All companies" detail={`${visibleCompanies.length} compan${visibleCompanies.length === 1 ? "y" : "ies"}`} />
              {visibleCompanies.length ? <CompanyRows companies={visibleCompanies} onSelect={chooseCompany} /> : <EmptyState icon="⌂" title={companies.length ? "No matching companies" : "No companies yet"} detail={companies.length ? "Try another search." : me?.role === "super_admin" ? "Create the first company." : "Ask a super admin to assign you to a company."} action={me?.role === "super_admin" && !companies.length ? <button className="primary-action" onClick={() => setModal("company")}>Create company</button> : undefined} />}
            </>}
          </section>}

          {activeNav === "Members" && <section className="page-section">
            {me?.role === "super_admin" ? <>
              <div className="summary-strip"><Metric label="Users" value={users.length} /><Metric label="Memberships" value={memberCount} /><Metric label="Not assigned" value={unassignedUsers} /></div>
              <SectionHeading title={selectedCompanyRecord ? `${selectedCompanyRecord.name} members` : "All users"} detail={`${visibleUsers.length} user${visibleUsers.length === 1 ? "" : "s"}`} />
              {visibleUsers.length ? <UserRows users={visibleUsers} companies={companies} onAssign={(userId) => { setAssigningUserId(userId); setModal("assignUser"); }} /> : <EmptyState icon="♙" title={users.length ? "No matching members" : "No users yet"} detail={users.length ? "Try another search or company." : "Add a user, then assign them to one or more companies."} action={!users.length ? <button className="primary-action" onClick={() => setModal("addUser")}>Add user</button> : undefined} />}
            </> : <><SectionHeading title="Your company access" detail={`${companies.length} compan${companies.length === 1 ? "y" : "ies"}`} />{companies.length ? <CompanyRows companies={visibleCompanies} onSelect={chooseCompany} /> : <EmptyState icon="♙" title="No company access" detail="Ask a super admin to assign your account to a company." />}</>}
          </section>}

          {activeNav === "Activity" && <section className="page-section"><SectionHeading title={selectedCompanyRecord ? `${selectedCompanyRecord.name} activity` : "Workspace activity"} detail={`${visibleActivity.length} event${visibleActivity.length === 1 ? "" : "s"}`} />{visibleActivity.length ? <ActivityTimeline items={visibleActivity} /> : <EmptyState icon="◌" title="No activity found" detail={activity.length ? "Try another search or company." : "New companies, users, albums, and uploads will appear here."} />}</section>}
        </>}
      </div>
    </section>

    {modal && <div className="modal-backdrop" onMouseDown={(event) => { if (event.target === event.currentTarget) setModal(null); }}><div className={`modal ${modal === "addUser" ? "wide-modal" : ""}`} role="dialog" aria-modal="true"><button className="modal-close" onClick={() => setModal(null)} aria-label="Close">×</button>{modal === "company" && <ActionForm title="Create company" onSubmit={createCompany}><label>Company name<input name="name" required autoFocus placeholder="Atlas Creative" /></label></ActionForm>}{modal === "album" && <ActionForm title="Create album" detail="Choose a company." onSubmit={createAlbum}><label>Album name<input name="name" required autoFocus placeholder="Autumn campaign" /></label><CompanySelect companies={companies} selectedId={selectedCompany} /></ActionForm>}{modal === "addUser" && <ActionForm title="Add user" onSubmit={createUser}><div className="field-row"><label>First name<input name="firstName" required autoFocus autoComplete="off" /></label><label>Last name<input name="lastName" required autoComplete="off" /></label></div><label>Username<input name="username" required minLength={3} autoComplete="off" placeholder="maya.ortiz" /></label><label>Email<input name="email" type="email" required autoComplete="off" placeholder="maya@company.com" /></label><label>Password<input name="password" type="password" required minLength={8} maxLength={128} autoComplete="new-password" /><small className="field-help">Minimum 8 characters.</small></label></ActionForm>}{modal === "assignUser" && <ActionForm title="Assign user" detail="A user can belong to multiple companies." onSubmit={assignUser}><UserSelect users={users} selectedId={assigningUserId} /><CompanySelect companies={companies} selectedId={selectedCompany} /></ActionForm>}</div></div>}

    {openAlbum && <div className="modal-backdrop" onMouseDown={(event) => { if (event.target === event.currentTarget) setOpenAlbum(null); }}><div className="media-modal" role="dialog" aria-modal="true"><div className="media-modal-head"><div><p>Album</p><h2>{openAlbum.name}</h2><small>{media.length} files</small></div><div><button className="download-button" onClick={() => downloadAlbum(openAlbum)}>↓ Download</button><label className={`upload-button ${uploading ? "disabled" : ""}`}>{uploading ? "Uploading…" : "＋ Upload media"}<input type="file" multiple accept="image/*,video/*" disabled={uploading} onChange={(event) => uploadFiles(event.target.files)} /></label><button className="modal-close static" onClick={() => setOpenAlbum(null)} aria-label="Close album">×</button></div></div>{media.length ? <div className="media-grid">{media.map((item) => <figure key={item._id}>{item.kind === "image" ? <img src={item.url} alt={item.filename} /> : <video src={item.url} controls preload="metadata" />}<figcaption><b>{item.filename}</b><small>{formatBytes(item.bytes)}</small></figcaption></figure>)}</div> : <div className="empty-state media-empty"><span>◫</span><h3>This album is empty</h3><p>Upload images or videos.</p></div>}</div></div>}
    {!!uploads.length && <UploadTray uploads={uploads} onClear={() => setUploads((current) => current.filter((item) => item.status !== "complete" && item.status !== "error"))} />}
    {toast && <div className="toast"><span>✓</span>{toast}</div>}
  </main>;
}

function Stat({ label, value, icon, tone }: { label: string; value: string | number; icon: string; tone: string }) { return <article className="stat-card"><div className={`stat-icon ${tone}`}>{icon}</div><span><small>{label}</small><strong>{value}</strong></span></article>; }
function SectionHeading({ title, detail, action }: { title: string; detail: string; action?: React.ReactNode }) { return <div className="section-heading"><div><h2>{title}</h2><p>{detail}</p></div>{action}</div>; }
function Metric({ label, value }: { label: string; value: string | number }) { return <span className="metric"><small>{label}</small><b>{value}</b></span>; }
function EmptyState({ icon, title, detail, action }: { icon: string; title: string; detail: string; action?: React.ReactNode }) { return <div className="empty-state"><span>{icon}</span><h3>{title}</h3><p>{detail}</p>{action}</div>; }
function CompanyRows({ companies, onSelect }: { companies: Company[]; onSelect: (companyId: string) => void }) { return <div className="company-rows">{companies.map((company) => <button className="company-row" key={company._id} onClick={() => onSelect(company._id)}><span className="company-logo blue">{companyInitials(company.name)}</span><span className="company-main"><b>{company.name}</b><small>{company.memberCount} member{company.memberCount === 1 ? "" : "s"}</small></span><span><b>{company.albumCount}</b><small>Albums</small></span><span><b>{formatBytes(company.storageBytes)}</b><small>Storage</small></span><span className="row-arrow">→</span></button>)}</div>; }
function AlbumCollection({ albums, companies, onOpen, onDownload, onNew, canCreate, emptyMessage }: { albums: Album[]; companies: Company[]; onOpen: (album: Album) => void; onDownload: (album: Album) => void; onNew: () => void; canCreate: boolean; emptyMessage: string }) {
  if (!albums.length) return <EmptyState icon="▱" title="No albums here yet" detail={emptyMessage} action={canCreate ? <button className="primary-action" onClick={onNew}>Create album</button> : undefined} />;
  return <div className="album-grid">{albums.map((album) => <article className="album-card" key={album._id} tabIndex={0} role="button" onClick={() => onOpen(album)} onKeyDown={(event) => { if (event.key === "Enter" || event.key === " ") { event.preventDefault(); onOpen(album); } }}><div className="album-cover real-cover"><button className="album-download" aria-label={`Download ${album.name}`} onClick={(event) => { event.stopPropagation(); onDownload(album); }} onKeyDown={(event) => event.stopPropagation()}>↓</button><span className="album-initial">{companyInitials(album.name)}</span><span className="album-badge">{album.itemCount} items</span></div><div className="album-meta"><div><h3>{album.name}</h3><p>{companies.find((company) => company._id === album.companyId)?.name}</p></div><time>{formatDate(album.updatedAt)}</time></div></article>)}{canCreate && <button className="new-album-card" onClick={onNew}><span>＋</span><b>Create an album</b><small>Add images and videos</small></button>}</div>;
}
function UploadTray({ uploads, onClear }: { uploads: UploadTask[]; onClear: () => void }) { const active = uploads.some((item) => item.status !== "complete" && item.status !== "error"); return <aside className="upload-tray" aria-live="polite"><div className="upload-tray-head"><div><b>{active ? "Uploading media" : "Uploads finished"}</b><small>{uploads.length} file{uploads.length === 1 ? "" : "s"}</small></div>{!active && <button onClick={onClear}>Clear</button>}</div><div className="upload-list">{uploads.map((item) => <div className={`upload-item ${item.status}`} key={item.id}><div className="upload-line"><b>{item.filename}</b><span>{uploadStatus(item)}</span></div><div className="upload-progress"><span style={{ width: `${item.progress}%` }} /></div></div>)}</div></aside>; }
function UserRows({ users, companies, onAssign }: { users: WorkspaceUser[]; companies: Company[]; onAssign: (userId: string) => void }) { return <div className="user-rows">{users.map((user) => <div className="user-row" key={user._id}><span className="avatar">{companyInitials(user.name)}</span><span className="user-main"><b>{user.name}</b><small>@{user.username} · {user.email}</small><span className="company-chips">{user.companyIds.length ? user.companyIds.map((companyId) => <em key={companyId}>{companies.find((company) => company._id === companyId)?.name ?? "Company"}</em>) : <em className="unassigned">Not assigned</em>}</span></span><span><b>{user.companyIds.length}</b><small>Companies</small></span><button onClick={() => onAssign(user._id)}>Assign</button></div>)}</div>; }
function ActivityTimeline({ items }: { items: ActivityItem[] }) { return <div className="activity-list">{items.map((item) => { const kind = item.targetType === "user" ? "member" : item.targetType; return <article className="activity-row" key={item._id}><span className={`activity-mark ${kind}`}>{kind === "company" ? "⌂" : kind === "member" ? "♙" : kind === "media" ? "◫" : "▱"}</span><div><b>{item.detail}</b><p>By <strong>{item.actor.name}</strong>{item.actor.email ? ` · ${item.actor.email}` : ""}</p></div><time>{formatActivityDate(item.createdAt)}</time></article>; })}</div>; }
function CompanySelect({ companies, selectedId }: { companies: Company[]; selectedId?: string }) { return <label>Company<select name="companyId" required defaultValue={selectedId && selectedId !== "all" ? selectedId : companies[0]?._id}>{companies.map((company) => <option key={company._id} value={company._id}>{company.name}</option>)}</select></label>; }
function UserSelect({ users, selectedId }: { users: WorkspaceUser[]; selectedId: string }) { return <label>User<select name="userId" required defaultValue={selectedId || users[0]?._id}>{users.map((user) => <option key={user._id} value={user._id}>{user.name} · {user.email}</option>)}</select></label>; }
function ActionForm({ title, detail, onSubmit, children }: { title: string; detail?: string; onSubmit: (event: FormEvent<HTMLFormElement>) => void; children: React.ReactNode }) { return <form onSubmit={onSubmit}><span className="modal-symbol">◇</span><h2>{title}</h2>{detail && <p>{detail}</p>}{children}<button className="modal-submit">Save <span>→</span></button></form>; }
function companyInitials(name: string) { return name.split(/\s+/).slice(0, 2).map((part) => part[0]).join("").toUpperCase(); }
function formatBytes(bytes: number) { if (!bytes) return "0 B"; const units = ["B", "KB", "MB", "GB", "TB"]; const index = Math.min(Math.floor(Math.log(bytes) / Math.log(1024)), units.length - 1); return `${(bytes / 1024 ** index).toFixed(index ? 1 : 0)} ${units[index]}`; }
function formatDate(value: string) { return new Intl.DateTimeFormat(undefined, { month: "short", day: "numeric" }).format(new Date(value)); }
function formatActivityDate(value: string) { return new Intl.DateTimeFormat(undefined, { month: "short", day: "numeric", year: new Date(value).getFullYear() === new Date().getFullYear() ? undefined : "numeric" }).format(new Date(value)); }
function createUploadId() { return typeof crypto.randomUUID === "function" ? crypto.randomUUID() : `${Date.now()}-${Math.random().toString(16).slice(2)}`; }
function uploadStatus(item: UploadTask) { if (item.status === "complete") return "Complete"; if (item.status === "error") return item.error ?? "Failed"; if (item.status === "processing") return "Finishing…"; if (item.status === "preparing") return "Preparing…"; return `${item.progress}%`; }
function putFile(url: string, file: File, onProgress: (percent: number) => void) {
  return new Promise<void>((resolve, reject) => {
    const request = new XMLHttpRequest();
    request.open("PUT", url, true);
    request.setRequestHeader("Content-Type", file.type);
    request.upload.onprogress = (event) => { if (event.lengthComputable && event.total) onProgress(Math.round((event.loaded / event.total) * 100)); };
    request.onload = () => request.status >= 200 && request.status < 300 ? resolve() : reject(new Error(`Upload failed for ${file.name}`));
    request.onerror = () => reject(new Error(`Upload failed for ${file.name}`));
    request.onabort = () => reject(new Error(`Upload cancelled for ${file.name}`));
    request.send(file);
  });
}
