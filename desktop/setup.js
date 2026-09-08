const networks = document.getElementById('networks');
const status = document.getElementById('status');
const start = document.getElementById('start');
const refresh = document.getElementById('refresh');
async function update() {
  start.disabled = true;
  try {
    const state = await window.hostSetup.state();
    networks.replaceChildren();
    state.addresses.forEach((item, index) => {
      const label = document.createElement('label'); label.className = 'mode-option';
      const input = document.createElement('input'); Object.assign(input, { type: 'radio', name: 'network', value: item.address, checked: index === 0 });
      const text = document.createElement('span');
      const title = document.createElement('strong'); title.textContent = item.address;
      const hint = document.createElement('small'); hint.textContent = item.name;
      text.append(title, hint); label.append(input, text); networks.append(label);
    });
    start.disabled = !state.addresses.length;
    status.textContent = state.error || (state.addresses.length ? 'Bereit. LiveKit und die Web-App werden automatisch gestartet.' : 'Noch kein lokales Netzwerk gefunden. Bitte WLAN oder Netzwerkkabel verbinden und erneut prüfen.');
  } catch { status.textContent = 'Die App konnte nicht vorbereitet werden. Bitte erneut öffnen.'; }
}
refresh.addEventListener('click', update);
start.addEventListener('click', async () => {
  const ip = document.querySelector('input[name="network"]:checked')?.value;
  if (!ip) return;
  start.disabled = true; refresh.disabled = true; networks.closest('fieldset').disabled = true;
  status.textContent = 'Dein Host wird gestartet…';
  try {
    const result = await window.hostSetup.start(ip);
    if (result.error) status.textContent = result.error;
  } catch { status.textContent = 'Start fehlgeschlagen. Bitte erneut versuchen.'; }
  finally { start.disabled = false; refresh.disabled = false; networks.closest('fieldset').disabled = false; }
});
update();
