#!/usr/bin/env node
// gh-wrapped: coleta os últimos 365 dias via `gh` (usa o token dele) e gera a retrospectiva + cards PNG.
// Uso: node wrapped.mjs [login]   |   node wrapped.mjs --rebuild   (saída em ./out)
import { execFileSync } from 'node:child_process';
import { readFileSync, writeFileSync, mkdirSync, readdirSync, existsSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';

const here = dirname(fileURLToPath(import.meta.url));
const outDir = join(process.cwd(), 'out');
const tz = Intl.DateTimeFormat().resolvedOptions().timeZone;

const gh = (...args) => execFileSync('gh', args, { encoding: 'utf8', maxBuffer: 1 << 28 });
function gql(query, variables = {}) {
  const out = execFileSync('gh', ['api', 'graphql', '--input', '-'], {
    input: JSON.stringify({ query, variables }), encoding: 'utf8', maxBuffer: 1 << 28,
  });
  const j = JSON.parse(out);
  if (j.errors) throw new Error(JSON.stringify(j.errors));
  return j.data;
}
const log = (m) => process.stderr.write(m + '\n');

// --rebuild: refaz HTML e cards a partir do último JSON, sem chamar a API
if (process.argv.includes('--rebuild')) {
  const dir = outDir;
  const last = readdirSync(dir).filter((f) => f.endsWith('.json')).sort().at(-1);
  render(JSON.parse(readFileSync(join(dir, last), 'utf8')));
  process.exit(0);
}

const login = process.argv.slice(2).find((a) => !a.startsWith('--')) || gh('api', 'user', '--jq', '.login').trim();
const to = new Date();
const from = new Date(to);
from.setFullYear(to.getFullYear() - 1);
const fromDay = localDate(from), toDay = localDate(to);

function localParts(d) {
  const p = Object.fromEntries(new Intl.DateTimeFormat('en-CA', {
    timeZone: tz, year: 'numeric', month: '2-digit', day: '2-digit', hour: '2-digit', minute: '2-digit', hourCycle: 'h23', weekday: 'short',
  }).formatToParts(d).map((x) => [x.type, x.value]));
  return { date: `${p.year}-${p.month}-${p.day}`, hour: +p.hour, minute: +p.minute };
}
function localDate(d) { return localParts(d).date; }

// ---------- 1. Perfil + contribuições ----------
log(`> @${login}: ${fromDay} → ${toDay} (${tz})`);
const main = gql(`query($login:String!,$from:DateTime!,$to:DateTime!){
  user(login:$login){
    id login name avatarUrl url createdAt
    followers{totalCount} following{totalCount}
    contributionsCollection(from:$from,to:$to){
      totalCommitContributions totalIssueContributions totalPullRequestContributions
      totalPullRequestReviewContributions totalRepositoryContributions restrictedContributionsCount
      contributionCalendar{ totalContributions weeks{ contributionDays{ date contributionCount } } }
      commitContributionsByRepository(maxRepositories:100){
        repository{ nameWithOwner name owner{login} isPrivate url description stargazerCount primaryLanguage{name color} }
        contributions{ totalCount }
      }
      pullRequestContributions(first:100){ totalCount nodes{ pullRequest{ title url merged createdAt additions deletions repository{ nameWithOwner } } } }
      issueContributions(first:100){ totalCount }
      repositoryContributions(first:100){ totalCount nodes{ occurredAt repository{ nameWithOwner name isPrivate description stargazerCount primaryLanguage{name color} } } }
    }
  }
}`, { login, from: from.toISOString(), to: to.toISOString() }).user;
const cc = main.contributionsCollection;

// ---------- 2. Repos próprios (estrelas ganhas no período) ----------
log('> repositórios e estrelas');
const owned = [];
for (let cursor = null; ;) {
  const r = gql(`query($login:String!,$cursor:String){ user(login:$login){ repositories(ownerAffiliations:OWNER,isFork:false,first:100,after:$cursor){
    pageInfo{hasNextPage endCursor}
    nodes{ nameWithOwner name isPrivate stargazerCount forkCount createdAt pushedAt primaryLanguage{name color}
      stargazers(first:100,orderBy:{field:STARRED_AT,direction:DESC}){ edges{ starredAt } } }
  } } }`, { login, cursor }).user.repositories;
  owned.push(...r.nodes);
  if (!r.pageInfo.hasNextPage) break;
  cursor = r.pageInfo.endCursor;
}

// ---------- 3. Commits ----------
// O contributionsCollection esconde repos privados (viram só "restrictedContributionsCount"),
// então a lista de repos vem de repositoriesContributedTo + repos próprios com push no período,
// e os commits são contados direto do histórico da branch padrão.
const candidates = new Set(owned.filter((r) => r.pushedAt >= from.toISOString()).map((r) => r.nameWithOwner));
for (let cursor = null; ;) {
  const r = gql(`query($cursor:String){ viewer{ repositoriesContributedTo(first:100,after:$cursor,includeUserRepositories:true,contributionTypes:[COMMIT]){
    pageInfo{hasNextPage endCursor} nodes{ nameWithOwner } } } }`, { cursor }).viewer.repositoriesContributedTo;
  r.nodes.forEach((n) => candidates.add(n.nameWithOwner));
  if (!r.pageInfo.hasNextPage) break;
  cursor = r.pageInfo.endCursor;
}
for (const r of cc.commitContributionsByRepository) candidates.add(r.repository.nameWithOwner);

const commits = [];
const repoInfo = {};
for (const full of candidates) {
  const [owner, name] = full.split('/');
  let n = 0;
  for (let cursor = null, page = 0; page < 30; page++) {
    let repo;
    try {
      repo = gql(`query($owner:String!,$name:String!,$since:GitTimestamp!,$until:GitTimestamp!,$author:ID!,$cursor:String){
        repository(owner:$owner,name:$name){ nameWithOwner name isPrivate description stargazerCount primaryLanguage{name color}
          defaultBranchRef{ target{ ... on Commit{
            history(first:100,after:$cursor,since:$since,until:$until,author:{id:$author}){
              pageInfo{hasNextPage endCursor} nodes{ oid authoredDate additions deletions messageHeadline }
          } } } } } }`,
        { owner, name, since: from.toISOString(), until: to.toISOString(), author: main.id, cursor },
      ).repository;
    } catch (e) { log(`  ${full} pulado: ${String(e.message).slice(0, 120)}`); break; }
    const h = repo?.defaultBranchRef?.target?.history;
    if (!h) break;
    repoInfo[full] = repo;
    for (const c of h.nodes) commits.push({ ...c, repo: full });
    n += h.nodes.length;
    if (!h.pageInfo.hasNextPage) break;
    cursor = h.pageInfo.endCursor;
  }
  if (n) log(`> ${full}: ${n} commits`);
}
const perRepo = {};
for (const c of commits) perRepo[c.repo] = (perRepo[c.repo] || 0) + 1;
const commitRepos = Object.entries(perRepo).sort((a, b) => b[1] - a[1])
  .map(([full, count]) => ({ repository: repoInfo[full], contributions: { totalCount: count } }));

// ---------- 4. Estatísticas ----------
const days = cc.contributionCalendar.weeks.flatMap((w) => w.contributionDays)
  .filter((d) => d.date >= fromDay && d.date <= toDay)
  .map((d) => ({ date: d.date, count: d.contributionCount }))
  .sort((a, b) => a.date.localeCompare(b.date));
const total = days.reduce((s, d) => s + d.count, 0);
const activeDays = days.filter((d) => d.count > 0).length;
const bestDay = days.reduce((m, d) => (d.count > m.count ? d : m), { count: -1 });

let longest = { len: 0 }, run = null;
for (const d of days) {
  if (d.count > 0) { run = run ? { ...run, len: run.len + 1, end: d.date } : { len: 1, start: d.date, end: d.date }; if (run.len > longest.len) longest = run; }
  else run = null;
}
let current = 0;
for (let i = days.length - 1; i >= 0; i--) {
  if (days[i].count > 0) current++;
  else if (i === days.length - 1) continue; // hoje ainda pode estar vazio
  else break;
}

const weekday = Array(7).fill(0);
for (const d of days) weekday[new Date(d.date + 'T12:00:00Z').getUTCDay()] += d.count;
const months = [];
for (const d of days) {
  const k = d.date.slice(0, 7);
  if (!months.length || months.at(-1).month !== k) months.push({ month: k, count: 0 });
  months.at(-1).count += d.count;
}

const hours = Array(24).fill(0);
let adds = 0, dels = 0, latest = null, first = null;
for (const c of commits) {
  const p = localParts(new Date(c.authoredDate));
  hours[p.hour]++;
  if (c.additions + c.deletions <= 5000) { adds += c.additions; dels += c.deletions; } // corta lockfile/build/vendor
  const late = ((p.hour + 24 - 5) % 24) * 60 + p.minute; // 04:59 = mais tarde possível
  if (!latest || late > latest.late) latest = { late, time: `${String(p.hour).padStart(2, '0')}:${String(p.minute).padStart(2, '0')}`, date: p.date, msg: c.messageHeadline, repo: c.repo };
  if (!first || c.authoredDate < first.authoredDate) first = c;
}

const stop = new Set(('the and for with from into this that add adds added update updated use when not are was ' +
  'de da do das dos em no na nos nas um uma com por para pra que os as ao se mais sem ver merge branch pull request main master into').split(' '));
const words = {};
for (const c of commits) for (const w of c.messageHeadline.toLowerCase().match(/[\p{L}][\p{L}-]{2,}/gu) || []) if (!stop.has(w)) words[w] = (words[w] || 0) + 1;
const topWords = Object.entries(words).sort((a, b) => b[1] - a[1]).slice(0, 14).map(([word, count]) => ({ word, count }));

const langs = {};
for (const r of commitRepos) {
  const l = r.repository.primaryLanguage; if (!l) continue;
  langs[l.name] ??= { name: l.name, color: l.color || '#888', commits: 0 };
  langs[l.name].commits += r.contributions.totalCount;
}
const languages = Object.values(langs).sort((a, b) => b.commits - a.commits);

const topRepos = commitRepos.slice(0, 6).map((r) => ({
  name: r.repository.nameWithOwner, short: r.repository.name, private: r.repository.isPrivate, description: r.repository.description,
  stars: r.repository.stargazerCount, language: r.repository.primaryLanguage, commits: r.contributions.totalCount,
}));

const fromIso = from.toISOString();
const starsByRepo = owned.map((r) => ({ name: r.name, gained: r.stargazers.edges.filter((e) => e.starredAt >= fromIso).length, stars: r.stargazerCount }))
  .filter((r) => r.gained > 0).sort((a, b) => b.gained - a.gained);
const newRepos = owned.filter((r) => r.createdAt >= fromIso)
  .map((r) => ({ name: r.name, private: r.isPrivate, createdAt: r.createdAt, language: r.primaryLanguage, stars: r.stargazerCount }))
  .sort((a, b) => a.createdAt.localeCompare(b.createdAt));

const prs = cc.pullRequestContributions.nodes.map((n) => n.pullRequest).filter(Boolean);
const biggestPr = prs.reduce((m, p) => (!m || p.additions + p.deletions > m.additions + m.deletions ? p : m), null);

const nCommits = commits.length || 1;
const share = (a, b) => hours.slice(a, b).reduce((s, x) => s + x, 0) / nCommits;
const night = share(22, 24) + share(0, 5), morning = share(5, 10);
const weekendShare = (weekday[0] + weekday[6]) / (total || 1);
const persona =
  night > 0.3 ? { title: 'Coruja do terminal', line: 'Seu código acorda quando a cidade dorme.' }
  : morning > 0.3 ? { title: 'Madrugador', line: 'Café, commit, e o dia mal começou.' }
  : weekendShare > 0.4 ? { title: 'Guerreiro de fim de semana', line: 'Sábado é dia de deploy, né?' }
  : longest.len >= 30 ? { title: 'Maratonista', line: 'Um mês sem parar. Respeito.' }
  : activeDays >= 200 ? { title: 'Relógio suíço', line: 'Constância é o seu superpoder.' }
  : { title: 'Artesão do horário comercial', line: 'Disciplina de nove às seis.' };

const data = {
  generatedAt: to.toISOString(), tz, from: fromDay, to: toDay,
  user: { login: main.login, name: main.name, avatar: main.avatarUrl, url: main.url, createdAt: main.createdAt, followers: main.followers.totalCount },
  totals: {
    contributions: total, commits: cc.totalCommitContributions, prs: cc.totalPullRequestContributions, issues: cc.issueContributions.totalCount,
    reviews: cc.totalPullRequestReviewContributions, repos: cc.totalRepositoryContributions, private: cc.restrictedContributionsCount,
    reposTouched: commitRepos.length, prsMerged: prs.filter((p) => p.merged).length,
    commitsRead: commits.length, commitsPrivate: commits.filter((c) => repoInfo[c.repo].isPrivate).length,
  },
  days, activeDays, bestDay, longest, current, weekday, months, hours,
  lines: { adds, dels, sampled: commits.length }, latest, first: first && { date: localDate(new Date(first.authoredDate)), msg: first.messageHeadline, repo: first.repo },
  topWords, languages, topRepos, starsGained: starsByRepo.reduce((s, r) => s + r.gained, 0), starsByRepo, newRepos,
  biggestPr: biggestPr && { title: biggestPr.title, repo: biggestPr.repository.nameWithOwner, additions: biggestPr.additions, deletions: biggestPr.deletions, merged: biggestPr.merged },
  persona,
  commitsByRepo: perRepo,
};

mkdirSync(outDir, { recursive: true });
writeFileSync(join(outDir, `wrapped-${login}-${toDay}.json`), JSON.stringify(data, null, 2));
log(`> ${total} contribuições, ${commits.length} commits lidos`);
render(data);

function render(data) {
  for (const theme of ['riso', 'mono']) renderTheme(data, theme);
}

function renderTheme(data, theme) {
  const suf = theme === 'mono' ? '-mono' : '';
  const html = readFileSync(join(here, 'template.html'), 'utf8')
    .replace('__THEME__', theme)
    .replace('__DATA__', () => JSON.stringify(data).replace(/</g, '\\u003c'));
  const out = outDir;
  const file = join(out, `wrapped-${data.user.login}-${data.to}${suf}.html`);
  writeFileSync(file, html);

  // cards PNG via Chrome/Edge headless (Windows já vem com o Edge); CHROME_PATH força outro
  const browser = [
    process.env.CHROME_PATH,
    'C:/Program Files (x86)/Microsoft/Edge/Application/msedge.exe',
    'C:/Program Files/Microsoft/Edge/Application/msedge.exe',
    'C:/Program Files/Google/Chrome/Application/chrome.exe',
    '/Applications/Google Chrome.app/Contents/MacOS/Google Chrome',
    '/Applications/Microsoft Edge.app/Contents/MacOS/Microsoft Edge',
    '/usr/bin/google-chrome', '/usr/bin/chromium', '/usr/bin/chromium-browser', '/usr/bin/microsoft-edge',
  ].find((p) => p && existsSync(p));
  if (!browser) { log('> Chrome/Edge não encontrado (defina CHROME_PATH): cards PNG não gerados'); console.log(file); return; }
  const profile = join(out, '.browser-profile');
  for (const [kind, h] of [['feed', 1350], ['story', 1920]]) {
    const png = join(out, `card-${data.user.login}-${data.to}${suf}-${kind}.png`);
    execFileSync(browser, [
      '--headless=new', '--disable-gpu', '--hide-scrollbars', '--force-device-scale-factor=1', '--no-first-run',
      `--user-data-dir=${profile}`, `--window-size=1080,${h}`, '--virtual-time-budget=6000', `--screenshot=${png}`,
      pathToFileURL(file).href + `#card=${kind}`,
    ], { stdio: 'ignore' });
    log(`> ${png}`);
  }
  console.log(file);
}
