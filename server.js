const express = require('express');
const cors = require('cors');
const path = require('path');
const { Server, Keypair, TransactionBuilder, Account, Operation, Asset } = require('stellar-sdk');
const bip39 = require('bip39');
const { derivePath } = require('ed25519-hd-key');

const app = express();
app.use(cors());
app.use(express.json());
app.use(express.static(path.join(__dirname, 'public')));

const HORIZON_URL = "https://api.mainnet.minepi.com";
const piServer = new Server(HORIZON_URL);
const NETWORK_PASSPHRASE = "Pi Network";

// Keypair Generator
function getKeypair(mnemonic) {
  try {
    const seed = bip39.mnemonicToSeedSync(mnemonic.toLowerCase().trim());
    const { key } = derivePath("m/44'/314159'/0'", seed.toString('hex'));
    return Keypair.fromRawEd25519Seed(Buffer.from(key));
  } catch (e) {
    return null;
  }
}

// Deep Lock Decoder
function extractTrueUnlockTime(predicate) {
  if (!predicate) return null;
  let maxTime = 0;
  let maxStr = null;

  const traverse = (node) => {
    if (!node) return;
    const timeVal = node.abs_before || node.absBefore;
    if (timeVal) {
      const t = new Date(timeVal).getTime();
      if (!isNaN(t) && t > maxTime) {
        maxTime = t;
        maxStr = timeVal;
      }
    }
    if (node.not) traverse(node.not);
    if (node.and && Array.isArray(node.and)) node.and.forEach(traverse);
    if (node.or && Array.isArray(node.or)) node.or.forEach(traverse);
  };

  traverse(predicate);
  return maxStr;
}

// Global Bot State in Cloud RAM
let botState = {
  isArmed: false,
  logs: [],
  timeOffset: 0,
  driftMs: -150, // Cloud optimized
  heartbeatTimer: null,
  armTimer: null,
  fireTimers: []
};

function addLog(msg, type = 'info') {
  const time = new Date().toLocaleTimeString('en-US', { hour12: false, fractionalSecondDigits: 3 });
  botState.logs.unshift({ time, msg, type });
  if (botState.logs.length > 100) botState.logs.pop();
  console.log(`[${time}] [${type.toUpperCase()}] ${msg}`);
}

// NTP Clock Calibration
async function calibrateClock() {
  try {
    const start = Date.now();
    const res = await fetch('https://worldtimeapi.org/api/timezone/Asia/Kolkata');
    const data = await res.json();
    const latency = (Date.now() - start) / 2;
    botState.timeOffset = new Date(data.utc_datetime).getTime() - (start + latency);
    addLog(`NTP Synced. Railway Offset: ${botState.timeOffset}ms`, 'success');
  } catch (e) {
    addLog('NTP Sync failed. Using Railway server hardware time.', 'warning');
  }
}
calibrateClock();

// API 1: Scan Balances
app.post('/api/scan', async (req, res) => {
  const { targetMnemonic } = req.body;
  const kp = getKeypair(targetMnemonic);
  if (!kp) return res.json({ success: false, error: 'Invalid Passphrase' });

  try {
    const response = await piServer.claimableBalances().claimant(kp.publicKey()).limit(10).order("asc").call();
    const balances = response.records.map(r => {
      let trueUnlock = null;
      if (r.claimants) {
        for (const c of r.claimants) {
          const t = extractTrueUnlockTime(c.predicate);
          if (t) { trueUnlock = t; break; }
        }
      }
      return { id: r.id, amount: r.amount, absBefore: trueUnlock };
    });
    res.json({ success: true, balances, pubKey: kp.publicKey() });
  } catch (err) {
    res.json({ success: false, error: err.message });
  }
});

// API 2: Arm & Pre-Sign Execution Engine
app.post('/api/arm', async (req, res) => {
  const { operationMode, targetMnemonic, sponsorPool, receiverAddress, selectedBalanceId, targetTime, surgeFee } = req.body;

  if (botState.isArmed) return res.json({ success: false, error: 'Bot is already armed!' });
  if (!targetMnemonic || !sponsorPool.length || !receiverAddress || !targetTime) {
    return res.json({ success: false, error: 'Missing required parameters' });
  }

  botState.isArmed = true;
  addLog(`🔥 TITAN BOT ARMED! Sponsors loaded: ${sponsorPool.length} | Max Fee: ${surgeFee} PI`, 'warning');

  // Parse Target Time
  const now = new Date(Date.now() + botState.timeOffset);
  const [hours, minutes, seconds] = targetTime.split(':').map(Number);
  let targetTimestamp = new Date(now.getFullYear(), now.getMonth(), now.getDate(), hours, minutes, seconds || 0).getTime();
  if (targetTimestamp <= now.getTime()) targetTimestamp += 86400000;

  // Schedule Build 10 Minutes Before T-0
  const buildTime = targetTimestamp - (10 * 60 * 1000);
  const delayToBuild = buildTime - (Date.now() + botState.timeOffset);

  const executeBuildAndSchedule = async () => {
    addLog(`Starting Superfast Parallel XDR Build for ${sponsorPool.length} Sponsors...`, 'warning');
    try {
      const targetKp = getKeypair(targetMnemonic);
      let amountToSendStr = '';

      if (operationMode === 'claim_and_transfer') {
        const response = await piServer.claimableBalances().claimant(targetKp.publicKey()).limit(10).call();
        const cb = response.records.find(r => r.id === selectedBalanceId);
        if (!cb) throw new Error('Target Claimable Balance not found on chain');
        amountToSendStr = cb.amount;
      } else {
        const targetAcc = await piServer.loadAccount(targetKp.publicKey());
        const native = targetAcc.balances.find(b => b.asset_type === 'native');
        if (!native) throw new Error('No balance found');
        amountToSendStr = (parseFloat(native.balance) - 1.01).toFixed(7);
      }

      // Parallel Fetch Accounts
      const tasks = sponsorPool.map(async (mn, idx) => {
        const spKp = getKeypair(mn);
        if (!spKp) return null;
        try {
          const acc = await piServer.loadAccount(spKp.publicKey());
          return { spKp, baseSeq: acc.sequenceNumber(), idx };
        } catch (e) { return null; }
      });

      const loadedSponsors = (await Promise.all(tasks)).filter(Boolean);
      addLog(`Loaded ${loadedSponsors.length} active sponsor ledgers in RAM!`, 'success');

      // Build XDRs (Dynamic Sharding Rule: 1 sponsor = 1 tx, 5 sponsors = 5 txs)
      const feeInStroops = Math.round(parseFloat(surgeFee) * 10000000).toString();
      const rawXdrs = [];
      const waveOffsets = [1, 2, 3]; // Distribute shots across T-1s, T-2s, T-3s

      loadedSponsors.forEach(item => {
        const { spKp, baseSeq, idx } = item;
        const txBuilder = new TransactionBuilder(new Account(spKp.publicKey(), baseSeq), {
          fee: feeInStroops,
          networkPassphrase: NETWORK_PASSPHRASE
        }).setTimeout(600);

        if (operationMode === 'claim_and_transfer') {
          txBuilder.addOperation(Operation.claimClaimableBalance({
            balanceId: selectedBalanceId,
            source: targetKp.publicKey()
          }));
        }

        txBuilder.addOperation(Operation.payment({
          source: targetKp.publicKey(),
          destination: receiverAddress,
          asset: Asset.native(),
          amount: amountToSendStr
        }));

        const tx = txBuilder.build();
        tx.sign(targetKp);
        tx.sign(spKp);

        rawXdrs.push({
          xdr: tx.toXDR(),
          secOffset: waveOffsets[idx % 3]
        });
      });

      addLog(`✅ Pre-signed ${rawXdrs.length} lethal XDR payloads! Waiting for T-0...`, 'success');

      // Start TCP Keep-Alive Heartbeat (Prevents 120s Stale Socket Trap)
      botState.heartbeatTimer = setInterval(() => {
        fetch(`${HORIZON_URL}/fee_stats`).catch(() => {});
      }, 10000);

      // Schedule Fire Waves
      [3, 2, 1].forEach(sec => {
        const waveShards = rawXdrs.filter(s => s.secOffset === sec);
        if (waveShards.length === 0) return;

        const exactWaveTime = (targetTimestamp - (sec * 1000)) + botState.driftMs;
        const delayToFire = exactWaveTime - (Date.now() + botState.timeOffset);

        const timer = setTimeout(() => {
          if (botState.heartbeatTimer) clearInterval(botState.heartbeatTimer);
          addLog(`💥 FIRING T-${sec}s WAVE (${waveShards.length} SHOTS) 💥`, 'warning');
          
          waveShards.forEach((shard, i) => {
            fetch(`${HORIZON_URL}/transactions`, {
              method: 'POST',
              headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
              body: `tx=${encodeURIComponent(shard.xdr)}`
            })
            .then(r => r.json())
            .then(d => {
              if (d.hash) addLog(`[T-${sec}s #${i+1}] 🏆 VICTORY! Hash: ${d.hash}`, 'success');
              else addLog(`[T-${sec}s #${i+1}] ❌ Failed: ${JSON.stringify(d?.extras?.result_codes || d.title)}`, 'error');
            })
            .catch(() => addLog(`[T-${sec}s #${i+1}] Network Error`, 'error'));
          });
          botState.isArmed = false;
        }, Math.max(0, delayToFire));

        botState.fireTimers.push(timer);
      });

    } catch (e) {
      addLog(`Fatal Build Error: ${e.message}`, 'error');
      disarmBot();
    }
  };

  if (delayToBuild <= 0) {
    addLog('Less than 10 mins to T-0. Building immediately...', 'warning');
    executeBuildAndSchedule();
  } else {
    addLog(`Waiting ${(delayToBuild/60000).toFixed(2)} mins to pre-sign XDRs...`, 'info');
    botState.armTimer = setTimeout(executeBuildAndSchedule, delayToBuild);
  }

  res.json({ success: true });
});

function disarmBot() {
  if (botState.armTimer) clearTimeout(botState.armTimer);
  if (botState.heartbeatTimer) clearInterval(botState.heartbeatTimer);
  botState.fireTimers.forEach(t => clearTimeout(t));
  botState.fireTimers = [];
  botState.isArmed = false;
  addLog('🔴 Bot Aborted & Disarmed.', 'info');
}

app.post('/api/disarm', (req, res) => {
  disarmBot();
  res.json({ success: true });
});

app.get('/api/status', (req, res) => {
  res.json({ isArmed: botState.isArmed, logs: botState.logs });
});

const PORT = process.env.PORT || 3000;
app.listen(PORT, () => console.log(`🚀 Titan Railway Server running on port ${PORT}`));
