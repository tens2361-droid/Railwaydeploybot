const express = require('express');
const cors = require('cors');
const path = require('path');
const StellarSdk = require('stellar-sdk'); // Import main library
const bip39 = require('bip39');
const { derivePath } = require('ed25519-hd-key');

const app = express();
app.use(cors());
app.use(express.json());
app.use(express.static(path.join(__dirname, 'public')));

// ✅ CORRECT SDK v11+ ACCESS
const piServer = new StellarSdk.Horizon.Server("https://api.mainnet.minepi.com");
const { TransactionBuilder, Account, Operation, Asset, Keypair } = StellarSdk;
const NETWORK_PASSPHRASE = "Pi Network";

function getKeypair(mnemonic) {
    try {
        const seed = bip39.mnemonicToSeedSync(mnemonic.toLowerCase().trim());
        const { key } = derivePath("m/44'/314159'/0'", seed.toString('hex'));
        return Keypair.fromRawEd25519Seed(Buffer.from(key));
    } catch (e) { return null; }
}

app.post('/api/arm', async (req, res) => {
    const { targetMnemonic, sponsorPool, receiverAddress, selectedBalanceId, targetTime, surgeFee } = req.body;
    
    // Exact Timestamp
    const [h, m, s] = targetTime.split(':');
    let targetTs = new Date().setHours(h, m, s, 0);
    if (targetTs <= Date.now()) targetTs += 86400000;

    const targetKp = getKeypair(targetMnemonic);
    const tasks = sponsorPool.map(async (mn, i) => {
        const spKp = getKeypair(mn);
        const acc = await piServer.loadAccount(spKp.publicKey());
        
        // ✅ CORRECT v11+ TRANSACTION BUILDER
        const tx = new TransactionBuilder(new Account(spKp.publicKey(), acc.sequenceNumber()), {
            fee: Math.round(parseFloat(surgeFee) * 10000000).toString(),
            networkPassphrase: NETWORK_PASSPHRASE
        })
        .setTimeout(60)
        .addOperation(Operation.payment({
            source: targetKp.publicKey(),
            destination: receiverAddress,
            asset: Asset.native(),
            amount: "0.01" 
        }))
        .build();
        
        tx.sign(targetKp);
        tx.sign(spKp);
        return { xdr: tx.toXDR(), wave: [1, 2, 3][i % 3] };
    });

    const packets = await Promise.all(tasks);
    
    // Instant Firing Logic
    [1, 2, 3].forEach(wave => {
        const waves = packets.filter(p => p.wave === wave);
        const delay = Math.max(0, (targetTs - (wave * 1000)) - Date.now());
        
        setTimeout(() => {
            waves.forEach(w => {
                fetch("https://api.mainnet.minepi.com/transactions", {
                    method: 'POST',
                    headers: {'Content-Type': 'application/x-www-form-urlencoded'},
                    body: `tx=${encodeURIComponent(w.xdr)}`
                }).then(r => r.json()).then(d => console.log("Result Hash:", d.hash));
            });
        }, delay);
    });

    res.json({ success: true });
});

app.listen(3000, () => console.log("TITAN ENGINE ACTIVE v11"));
