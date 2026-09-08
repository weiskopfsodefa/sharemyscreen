import { checkLiveKit, printLiveKitCheck } from './livekit-check.js';

const result = checkLiveKit();
printLiveKitCheck(result);
console.log('Dieser Check startet keinen Server und verändert keine Installation.');
if (result.ok) console.log('Starten: npm run start:local (prüft anschließend die LAN-Adresse und startet die Dienste).');
process.exitCode = result.ok ? 0 : 1;
