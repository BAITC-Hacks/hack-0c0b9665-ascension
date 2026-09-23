// Native links preserve open-in-new-tab, keyboard navigation and browser history.
const sectionIds = ['workspace', 'results', 'city', 'method'];
const links = [...document.querySelectorAll('.sidebar .nav-item[href^="#"]')];
function activate(id) {
  for (const link of links) {
    const active = link.hash === `#${id}`;
    link.classList.toggle('active', active);
    if (active) link.setAttribute('aria-current', 'location'); else link.removeAttribute('aria-current');
  }
}
function followHash(scroll = false) {
  const id = location.hash.slice(1);
  if (!sectionIds.includes(id)) { activate('workspace'); return; }
  activate(id);
  if (scroll) document.getElementById(id)?.scrollIntoView({ block: 'start', behavior: 'instant' });
}
window.addEventListener('hashchange', () => followHash());
window.addEventListener('simulator:ready', () => requestAnimationFrame(() => followHash(true)));
let scheduled = false;
window.addEventListener('scroll', () => {
  if (scheduled) return;
  scheduled = true;
  requestAnimationFrame(() => {
    scheduled = false;
    const threshold = Math.min(innerHeight * 0.3, 200);
    const sections = sectionIds.map(id => document.getElementById(id)).filter(section => section && section.getClientRects().length);
    const active = sections.filter(section => section.getBoundingClientRect().top <= threshold).at(-1);
    if (active) activate(active.id);
  });
}, { passive: true });
followHash();
