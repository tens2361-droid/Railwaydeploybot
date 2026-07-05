const express = require('express');
const cors = require('cors');
const path = require('path');
const StellarSdk = require('stellar-sdk');
const bip39 = require('bip39');
const { derivePath } = require('ed25519-hd-key');

const app = express();
app.use(cors());
app.use(express.json());
app.use(express.static(path.join(__dirname, 'public')));

// ✅ CORRECT SDK IMPORT FIX
const piServer = new StellarSdk.Horizon.Server("https://api.mainnet.minepi.com");
const NETWORK_PASSPHRASE = "Pi Network";

function getKeypair(mnemonic) {
    try {
        const seed = bip39.mnemonicToSeedSync(mnemonic.toLowerCase().trim());
        const { key } = derivePath("m/44'/314159'/0'", seed.toString('hex'));
        return StellarSdk.Keypair.fromRawEd25519Seed(Buffer.from(key));
    } catch (e) { return null; }
}

let botState = { isArmed: false, logs: [] };

function addLog(msg, type = 'info') {
    const time = new Date().toLocaleTimeString('en-US', { hour12: false });
    botState.logs.unshift({ time, msg, type });
    console.log(`[${time}] ${msg}`);
}

app.post('/api/scan', async (req, res) => {
    const { targetMnemonic } = req.body;
    const kp = getKeypair(targetMnemonic);
    if (!kp) return res.json({ success: false, error: 'Invalid Mnemonic' });

    try {
        const response = await piServer.claimableBalances().claimant(kp.publicKey()).limit(10).call();
        res.json({ success: true, balances: response.records });
    } catch (err) { res.json({ success: false, error: err.message }); }
});

app.post('/api/arm', async (req, res) => {
    const { targetMnemonic, sponsorPool, receiverAddress, selectedBalanceId, targetTime, surgeFee } = req.body;
    
    botState.isArmed = true;
    addLog("🚀 INSTANT STRIKE ARMED", "warning");

    const [h, m, s] = targetTime.split(':');
    let targetTs = new Date().setHours(h, m, s, 0);
    if (targetTs <= Date.now()) targetTs += 86400000;

    // Parallel Load & Sign
    const targetKp = getKeypair(targetMnemonic);
    const tasks = sponsorPool.map(async (mn, i) => {
        const spKp = getKeypair(mn);
        const acc = await piServer.loadAccount(spKp.publicKey());
        
        const tx = new StellarSdk.TransactionBuilder(new StellarSdk.Account(spKp.publicKey(), acc.sequenceNumber()), {
            fee: Math.round(parseFloat(surgeFee) * 10000000).toString(),
            networkPassphrase: NETWORK_PASSPHRASE
        })
        .setTimeout(60)
        .addOperation(StellarSdk.Operation.payment({
            source: targetKp.publicKey(),
            destination: receiverAddress,
            asset: StellarSdk.Asset.native(),
            amount: "0.01" 
        }))
        .build();
        
        tx.sign(targetKp);
        tx.sign(spKp);
        return { xdr: tx.toXDR(), wave: [1, 2, 3][i % 3] };
    });

    const packets = await Promise.all(tasks);
    addLog(`✅ ${packets.length} Packets ready in RAM`, "success");

    // Atomic Trigger
    [1, 2, 3].forEach(wave => {
        const waves = packets.filter(p => p.wave === wave);
        const delay = Math.max(0, (targetTs - (wave * 1000)) - Date.now());
        
        setTimeout(() => {
            waves.forEach(w => {
                fetch("https://api.mainnet.minepi.com/transactions", {
                    method: 'POST',
                    headers: {'Content-Type': 'application/x-www-form-urlencoded'},
                    body: `tx=${encodeURIComponent(w.xdr)}`
                }).then(r => r.json()).then(d => addLog(`Result: ${d.hash || d.title}`, "success"));
            });
        }, delay);
    });

    res.json({ success: true });
});

app.get('/api/status', (req, res) => res.json({ isArmed: botState.isArmed, logs: botState.logs }));
app.listen(3000, () => console.log("SERVER LIVE"));
