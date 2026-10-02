// ============================================================
// EDILBINGO SERVER
// EXPRESS + SOCKET.IO + TELEGRAM BOT
// ============================================================

require("dotenv").config();

const express = require("express");
const crypto = require("crypto");
const http = require("http");
const { Server } = require("socket.io");

// ============================================================
// APP
// ============================================================

const app = express();

const server = http.createServer(app);

const { generateCard } = require("./game/card");
const db = require("./database/database");

const io = new Server(server, {
    cors: {
        origin: "*"
    }
});

// Automatic lottery drawing. The server is authoritative and draws one
// unique number every few seconds after a room is started.
const AUTO_DRAW_INTERVAL_MS = Number(process.env.AUTO_DRAW_INTERVAL_MS || 3000);
const AUTO_BUYING_MS = Number(process.env.AUTO_BUYING_MS || 30000);
const VIP_MIN_BALANCE = 10; // Minimum balance required to enter/play VIP.
const SUPERBINGO_MIN_BALANCE = 50; // Minimum balance required to enter/play SuperBingo.
const DEMO_FIXED_BALANCE = Number(process.env.DEMO_FIXED_BALANCE || 30); // One shared starting balance for every room.
const VIP_BALANCE = DEMO_FIXED_BALANCE;
const SUPERBINGO_BALANCE = DEMO_FIXED_BALANCE;
const WINNER_PAYOUT_PERCENT = 80; // Percentage of ticket sales paid to the winner.
const WINNER_DISPLAY_MS = Number(process.env.WINNER_DISPLAY_MS || 15000); // Winner announcement before the next round opens.
const autoDrawTimers = new Map();
const autoStartTimers = new Map();

function createRegistrationCode() {
    return String(Math.floor(10000 + Math.random() * 90000));
}

// SuperBingo starts only at these exact Ethiopia (EAT / Africa-Addis_Ababa) times:
// Tuesday 04:20 PM, Thursday 05:00 PM, Saturday 05:00 PM, Sunday 05:00 PM.
const SUPERBINGO_SCHEDULE = {
    0: { hour: 17, minute: 0 }, // Sunday
    2: { hour: 16, minute: 20 }, // Tuesday
    4: { hour: 17, minute: 0 }, // Thursday
    6: { hour: 17, minute: 0 }  // Saturday
};
const SUPERBINGO_PLAY_DAYS = new Set(Object.keys(SUPERBINGO_SCHEDULE).map(Number));

function getNextSuperBingoStart(now = new Date()) {
    const addisFormatter = new Intl.DateTimeFormat("en-US", {
        timeZone: "Africa/Addis_Ababa",
        weekday: "short",
        year: "numeric",
        month: "2-digit",
        day: "2-digit",
        hour: "2-digit",
        minute: "2-digit",
        second: "2-digit",
        hourCycle: "h23"
    });

    const parts = Object.fromEntries(
        addisFormatter.formatToParts(now)
            .filter(p => p.type !== "literal")
            .map(p => [p.type, p.value])
    );

    // SuperBingo schedule is fixed in Ethiopia time (Africa/Addis_Ababa).
    // Build the Ethiopian local date/time as a UTC epoch explicitly.
    // Do NOT use `new Date(year, month, ...)` here because that constructor
    // uses the server machine timezone. If the server itself runs on EAT,
    // subtracting another 3 hours would make SuperBingo start 3 hours early.
    const currentLocal = {
        year: Number(parts.year),
        month: Number(parts.month),
        day: Number(parts.day),
        hour: Number(parts.hour),
        minute: Number(parts.minute),
        second: Number(parts.second)
    };

    const currentLocalEpoch = Date.UTC(
        currentLocal.year,
        currentLocal.month - 1,
        currentLocal.day,
        currentLocal.hour,
        currentLocal.minute,
        currentLocal.second
    ) - (3 * 60 * 60 * 1000);

    for (let offset = 0; offset <= 7; offset++) {
        const candidateUtc = new Date(Date.UTC(
            currentLocal.year,
            currentLocal.month - 1,
            currentLocal.day + offset,
            0, 0, 0
        ));
        const weekday = candidateUtc.getUTCDay();
        const schedule = SUPERBINGO_SCHEDULE[weekday];
        if (!schedule) continue;

        const candidateEpoch = Date.UTC(
            candidateUtc.getUTCFullYear(),
            candidateUtc.getUTCMonth(),
            candidateUtc.getUTCDate(),
            schedule.hour,
            schedule.minute,
            0
        ) - (3 * 60 * 60 * 1000);

        if (candidateEpoch <= currentLocalEpoch) continue;

        return new Date(candidateEpoch);
    }

    return new Date(now.getTime() + 7 * 24 * 60 * 60 * 1000);
}
function stopAutoStart(roomId) {
    const timer = autoStartTimers.get(roomId);
    if (timer) clearTimeout(timer);
    autoStartTimers.delete(roomId);
}

function scheduleAutoStart(roomId) {
    const room = getRoom(roomId);
    if (!room || room.gameStarted) return;

    // GoodBingo Bonus has its own dedicated prediction UI. Never start the
    // Bingo buying/drawing cycle for this room.
    if (room.id === BONUS_ROOM_ID) {
        stopAutoStart(roomId);
        return;
    }

    if (autoStartTimers.has(roomId)) return;

    // SuperBingo is a separate room from VIP. It does not use the normal
    // 30-second VIP buying countdown. Players can select their cartella
    // numbers before the scheduled date/time, but the game starts only then.
    if (room.id === "superbingo") {
        const nextStart = getNextSuperBingoStart();
        room.scheduledStartAt = nextStart.getTime();
        room.buyingEndsAt = nextStart.getTime();

        const remainingMs = Math.max(0, nextStart.getTime() - Date.now());
        const timer = setTimeout(() => {
            autoStartTimers.delete(roomId);

            const current = getRoom(roomId);
            if (!current || current.gameStarted) return;

            // Protect against an early/stale timer firing. SuperBingo may
            // enter the playing/drawing phase only when the exact scheduled
            // timestamp has actually been reached.
            if (Date.now() < nextStart.getTime()) {
                scheduleAutoStart(roomId);
                return;
            }

            current.buyingEndsAt = null;
            current.scheduledStartAt = nextStart.getTime();
            current.activeScheduledStartAt = nextStart.getTime();
            current.lastScheduledStartAt = nextStart.getTime();
            current.superbingoDrawAuthorized = true;

            // The room cycle continues even when nobody selected a number.
            // Selection -> playing -> selection must always keep running.
            current.gameStarted = true;
            current.calledNumbers = [];
            current.bingoClaimOpenUntil = null;
            startAutoDraw(roomId);

            emitToPrivatePlayerRooms(current, "gameStarted", player =>
                getPrivateRoomState(current, player.playerKey)
            );
            broadcastRoomState(current);

            console.log(
                `SUPERBINGO AUTO GAME START [${current.name}] at the scheduled EAT time`
            );
        }, remainingMs);

        autoStartTimers.set(roomId, timer);
        return;
    }

    // Existing behavior for VIP/EdilBingo remains unchanged.
    // ONE server-authoritative selection window per round.
    // The first player entering the selection room starts the round clock.
    // Every other player receives the exact same deadline, regardless of
    // when they enter or select their lucky number.
    const now = Date.now();
    if (!room.buyingEndsAt || room.buyingEndsAt <= now) {
        room.buyingStartedAt = now;
        room.buyingEndsAt = now + AUTO_BUYING_MS;
    }
    const remainingMs = Math.max(0, room.buyingEndsAt - now);

    const timer = setTimeout(() => {
        autoStartTimers.delete(roomId);
        const current = getRoom(roomId);
        if (!current || current.gameStarted) return;
        current.buyingEndsAt = null;
        // Do not cancel the round when there are zero players. The room
        // continuously moves from selection -> playing -> selection.
        current.gameStarted = true;
        current.calledNumbers = [];
        current.bingoClaimOpenUntil = null;
        startAutoDraw(roomId);
        emitToPrivatePlayerRooms(current, "gameStarted", player =>
            getPrivateRoomState(current, player.playerKey)
        );
        broadcastRoomState(current);
        console.log(`AUTO GAME START [${current.name}] after ${AUTO_BUYING_MS}ms buying period`);
    }, remainingMs);

    autoStartTimers.set(roomId, timer);
}

function stopAutoDraw(roomId) {
    const timer = autoDrawTimers.get(roomId);
    if (!timer) return;
    clearTimeout(timer.timeout);
    clearInterval(timer.interval);
    autoDrawTimers.delete(roomId);
}

function startAutoDraw(roomId) {
    const room = getRoom(roomId);
    if (!room) return;

    // GoodBingo Bonus is not a Bingo room. It has no Bingo-ball drawing.
    if (room.id === BONUS_ROOM_ID) {
        stopAutoDraw(roomId);
        room.gameStarted = false;
        return;
    }

    // SuperBingo is schedule-controlled. Starting node server.js, reconnecting,
    // or any early/manual start request must never begin drawing before the
    // scheduled date/time.
    if (room.id === "superbingo") {
        // NEVER start SuperBingo drawing as a side effect of server startup,
        // room navigation, reconnects, or a generic start request. Drawing
        // is started only by the scheduled SuperBingo timer below.
        const scheduled = Number(room.activeScheduledStartAt || 0);
        if (!room.superbingoDrawAuthorized || !Number.isFinite(scheduled) || scheduled <= 0 || Date.now() < scheduled) {
            room.gameStarted = false;
            room.scheduledStartAt = scheduled > 0 ? scheduled : getNextSuperBingoStart().getTime();
            room.buyingEndsAt = room.scheduledStartAt;
            stopAutoDraw(roomId);
            scheduleAutoStart(roomId);
            return;
        }
        // Even at/after the scheduled time, only the scheduled callback is
        // allowed to transition the room into drawing.
        if (!room.activeScheduledStartAt || room.activeScheduledStartAt !== scheduled) {
            room.gameStarted = false;
            stopAutoDraw(roomId);
            scheduleAutoStart(roomId);
            return;
        }
    }

    stopAutoDraw(roomId);
    const firstDrawDelay = Math.min(2000, AUTO_DRAW_INTERVAL_MS);
    const timer = { timeout: null, interval: null };

    timer.timeout = setTimeout(() => {
        const first = performDraw(roomId);
        if (!first.success) { stopAutoDraw(roomId); return; }
        timer.interval = setInterval(() => {
            const result = performDraw(roomId);
            if (!result.success) stopAutoDraw(roomId);
        }, AUTO_DRAW_INTERVAL_MS);
    }, firstDrawDelay);

    autoDrawTimers.set(roomId, timer);
}

// ============================================================
// MIDDLEWARE
// ============================================================

app.use(express.json());

app.use(express.static("public"));

// ============================================================
// CONFIGURATION
// ============================================================

const PORT = process.env.PORT || 3000;

const TELEGRAM_BOT_TOKEN =
    process.env.TELEGRAM_BOT_TOKEN;

const MINI_APP_URL =
    process.env.MINI_APP_URL;

// Telegram account(s) allowed to act as EdilBingo administrators.
// Set ADMIN_TELEGRAM_ID to the numeric Telegram user ID of the owner/admin.
const ADMIN_TELEGRAM_ID =
    process.env.ADMIN_TELEGRAM_ID
        ? String(process.env.ADMIN_TELEGRAM_ID).trim()
        : "";

function isTelegramAdmin(telegramId) {
    return Boolean(
        ADMIN_TELEGRAM_ID &&
        telegramId &&
        String(telegramId).trim() === ADMIN_TELEGRAM_ID
    );
}

// Admin-only phone search state. After /searchphone, the next phone number
// sent by that admin is looked up in the registered users table and the
// matching Telegram ID is returned. This does not query Telegram for private
// phone-to-user mappings; it uses the phone number the user registered with
// this bot.
const pendingAdminPhoneSearch = new Set();
const pendingDepositInputs = new Map();

function normalizeEthiopianPhone(value) {
    let phone = String(value || '').trim().replace(/[\s()-]/g, '');
    if (!phone) return '';
    if (phone.startsWith('+251')) phone = '0' + phone.slice(4);
    else if (phone.startsWith('251')) phone = '0' + phone.slice(3);
    return phone;
}

function formatPhoneForDisplay(phone) {
    const normalized = normalizeEthiopianPhone(phone);
    if (/^0[79]\d{8}$/.test(normalized)) return '+251' + normalized.slice(1);
    return String(phone || '');
}

function findUserByPhone(phone) {
    const normalized = normalizeEthiopianPhone(phone);
    if (!normalized) return null;
    return db.prepare(`
        SELECT id, telegram_id, first_name, username, phone_number, balance
        FROM users
        WHERE REPLACE(REPLACE(REPLACE(phone_number, ' ', ''), '-', ''), '+251', '0') = ?
           OR REPLACE(REPLACE(REPLACE(phone_number, ' ', ''), '-', ''), '251', '0') = ?
        LIMIT 1
    `).get(normalized, normalized);
}

// ============================================================
// CONFIGURATION DISPLAY
// ============================================================

console.log("");
console.log("========================================");
console.log("        EDILBINGO CONFIGURATION");
console.log("========================================");

console.log(
    "Telegram token:",
    TELEGRAM_BOT_TOKEN
        ? "CONFIGURED"
        : "MISSING"
);

console.log(
    "Mini App URL:",
    MINI_APP_URL || "MISSING"
);

console.log(
    "Telegram admin ID:",
    ADMIN_TELEGRAM_ID || "NOT CONFIGURED"
);

console.log("========================================");
console.log("");

// ============================================================
// ROOMS
// ============================================================

const rooms = {
    vip: {
        id: "vip", name: "VIP", entryFee: 10, lotteryNumbers: 500,
        calledNumbers: [], gameStarted: false, buyingStartedAt: null, buyingEndsAt: null, scheduledStartAt: null, activeScheduledStartAt: null, lastScheduledStartAt: null, superbingoDrawAuthorized: false, bingoClaimOpenUntil: null,
        players: new Map(), soldNumbers: new Map(), tickets: new Map(), usedCardSignatures: new Set(), roundTransition: false, roundNumber: 1, registrationCode: createRegistrationCode()
    },
    superbingo: {
        id: "superbingo", name: "SuperBingo", entryFee: 50, lotteryNumbers: 1500,
        calledNumbers: [], gameStarted: false, buyingStartedAt: null, buyingEndsAt: null, scheduledStartAt: null, bingoClaimOpenUntil: null,
        superbingoSelectionDeadlines: new Map(),
        players: new Map(), soldNumbers: new Map(), tickets: new Map(), usedCardSignatures: new Set(), roundTransition: false, roundNumber: 1, registrationCode: createRegistrationCode()
    },
    Edilbingo: {
        id: "Edilbingo", name: "EdilBingo Bonus", entryFee: 0, lotteryNumbers: 75,
        calledNumbers: [], gameStarted: false, buyingStartedAt: null, buyingEndsAt: null, scheduledStartAt: null, bingoClaimOpenUntil: null,
        players: new Map(), soldNumbers: new Map(), tickets: new Map(), usedCardSignatures: new Set(), roundTransition: false, roundNumber: 1, registrationCode: createRegistrationCode()
    }
};

// ============================================================
// DEFAULT ROOM
// ============================================================

const DEFAULT_ROOM = "vip";

// GoodBingo Bonus is a dedicated football/match-prediction room. It is NOT
// part of the Bingo drawing engine and must never auto-start or draw Bingo balls.
const BONUS_ROOM_ID = "Edilbingo";

// ============================================================
// ROOM HELPER
// ============================================================

function getRoom(roomId) {

    if (!roomId) {
        return null;
    }

    return rooms[roomId] || null;

}

function getPlayerKey(data = {}) {
    const telegramUserId = data.telegramUserId ? String(data.telegramUserId).trim() : null;
    const username = data.username ? String(data.username).trim().toLowerCase().replace(/^@/, "") : null;
    const playerId = data.playerId ? String(data.playerId).trim() : null;
    const name = data.name ? String(data.name).trim().toLowerCase() : null;

    // Telegram user ID is the canonical account identity. It is stable across
    // every device where the same Telegram account opens the Mini App.
    return telegramUserId
        ? `tg:${telegramUserId}`
        : username
            ? `user:${username}`
            : playerId
                ? `browser:${playerId}`
                : name
                    ? `name:${name}`
                    : null;
}

// The active room is stored against the Telegram account, not the device.
// This fixes the common case where Device A is in SuperBingo while Device B
// opens the generic /playing-room.html URL and would otherwise default to VIP.
function ensureTelegramAccountRecord(telegramUserId, username = null, firstName = null) {
    if (!telegramUserId) return;
    try {
        const id = String(telegramUserId);
        const existing = db.prepare(
            "SELECT id FROM users WHERE telegram_id = ? LIMIT 1"
        ).get(id);
        if (existing) {
            db.prepare(
                "UPDATE users SET username = COALESCE(?, username), first_name = COALESCE(?, first_name) WHERE telegram_id = ?"
            ).run(username || null, firstName || null, id);
            return;
        }
        // The game already supports development accounts without a prior
        // phone-registration row. Create the identity row with zero balance;
        // getDepositedAccount() remains responsible for the existing demo
        // starting balance behavior.
        db.prepare(
            "INSERT INTO users (telegram_id, username, first_name, balance) VALUES (?, ?, ?, 0)"
        ).run(id, username || null, firstName || null);
    } catch (error) {
        // A concurrent device may create the same row at the same time.
        if (!String(error.message).includes("UNIQUE constraint failed")) {
            console.warn("Could not ensure Telegram account record:", error.message);
        }
    }
}

function getAccountActiveRoom(telegramUserId) {
    if (!telegramUserId) return null;
    try {
        const row = db.prepare(
            "SELECT active_room FROM users WHERE telegram_id = ? LIMIT 1"
        ).get(String(telegramUserId));
        const active = String(row?.active_room || "").trim();
        return rooms && rooms[active] ? active : null;
    } catch (_) {
        return null;
    }
}

function setAccountActiveRoom(telegramUserId, roomId) {
    if (!telegramUserId || !roomId || !rooms[roomId]) return;
    try {
        const id = String(telegramUserId);
        const existing = db.prepare(
            "SELECT id FROM users WHERE telegram_id = ? LIMIT 1"
        ).get(id);
        if (existing) {
            db.prepare("UPDATE users SET active_room = ? WHERE telegram_id = ?").run(roomId, id);
        }
    } catch (error) {
        console.warn("Could not save active Bingo room:", error.message);
    }
}

// Telegram Web Apps provide signed initData. When it is available, verify it
// on the server and use the user.id contained in the signed payload rather
// than trusting a browser-supplied telegramUserId. This guarantees that the
// same Telegram account maps to the same player key on every device.
function verifyTelegramInitData(initData) {
    if (!initData || !TELEGRAM_BOT_TOKEN) return null;

    try {
        const params = new URLSearchParams(String(initData));
        const receivedHash = params.get("hash");
        const authDate = Number(params.get("auth_date") || 0);
        if (!receivedHash || !authDate) return null;

        // Reject very old Mini App sessions. Five minutes is intentionally
        // generous enough for a normal app launch while preventing stale data
        // from being reused as an identity credential.
        if (Math.abs(Date.now() / 1000 - authDate) > 300) return null;

        const dataCheckString = Array.from(params.entries())
            .filter(([key]) => key !== "hash")
            .sort(([a], [b]) => a.localeCompare(b))
            .map(([key, value]) => `${key}=${value}`)
            .join("\n");

        const secretKey = crypto
            .createHmac("sha256", "WebAppData")
            .update(TELEGRAM_BOT_TOKEN)
            .digest();
        const calculatedHash = crypto
            .createHmac("sha256", secretKey)
            .update(dataCheckString)
            .digest("hex");

        const a = Buffer.from(calculatedHash, "hex");
        const b = Buffer.from(receivedHash, "hex");
        if (a.length !== b.length || !crypto.timingSafeEqual(a, b)) return null;

        const rawUser = params.get("user");
        const user = rawUser ? JSON.parse(rawUser) : null;
        if (!user?.id) return null;

        return {
            id: String(user.id),
            username: user.username ? String(user.username).trim().toLowerCase().replace(/^@/, "") : null,
            firstName: user.first_name || "",
            lastName: user.last_name || ""
        };
    } catch (error) {
        console.warn("Telegram initData verification failed:", error.message);
        return null;
    }
}

function getVerifiedAdminFromRequest(req) {
    const initData =
        req.get("x-telegram-init-data") ||
        req.body?.telegramInitData ||
        req.query?.telegramInitData ||
        "";

    const verifiedUser = verifyTelegramInitData(initData);
    if (!verifiedUser) return null;
    if (!isTelegramAdmin(verifiedUser.id)) return null;
    return verifiedUser;
}

function ensureAdminHomeTables() {
    db.exec(`
        CREATE TABLE IF NOT EXISTS admin_announcements (
            id INTEGER PRIMARY KEY AUTOINCREMENT,
            title TEXT NOT NULL,
            message TEXT NOT NULL,
            sent_count INTEGER DEFAULT 0,
            failed_count INTEGER DEFAULT 0,
            created_at DATETIME DEFAULT CURRENT_TIMESTAMP
        );
    `);
}

ensureAdminHomeTables();

function resolvePlayerIdentity(data = {}, room = null) {
    const verifiedTelegramUser = verifyTelegramInitData(data.telegramInitData);
    const clientTelegramId = data.telegramUserId ? String(data.telegramUserId).trim() : null;
    const clientUsername = data.username ? String(data.username).trim().toLowerCase().replace(/^@/, "") : null;

    // Signed Telegram identity always wins. If a client accidentally sends a
    // different user ID, it cannot split the account into another game room.
    let telegramUserId = verifiedTelegramUser?.id || clientTelegramId || null;
    const username = verifiedTelegramUser?.username || clientUsername || null;

    // If Telegram's user object is temporarily unavailable on a device but
    // the account is registered, recover the canonical Telegram ID from the
    // server database by username. This keeps an account's cartella ownership
    // shared even when one client falls back to its username.
    if (!verifiedTelegramUser && !clientTelegramId && username) {
        try {
            const dbUser = db.prepare(
                "SELECT telegram_id FROM users WHERE lower(username) = lower(?) LIMIT 1"
            ).get(username);
            if (dbUser?.telegram_id) telegramUserId = String(dbUser.telegram_id);
        } catch (_) {}
    }

    let playerKey = getPlayerKey({
        telegramUserId,
        username,
        playerId: data.playerId,
        name: data.name
    });

    // Compatibility bridge: if one device has a Telegram ID while another
    // older client only supplied the username, resolve the username to the
    // already-connected account's canonical tg:* key in this room.
    if (room && username && !verifiedTelegramUser) {
        const existing = Array.from(room.players.values()).find(player =>
            player.username && String(player.username).trim().toLowerCase().replace(/^@/, "") === username
        );
        if (existing?.playerKey?.startsWith("tg:")) {
            playerKey = existing.playerKey;
        }
    }

    return {
        playerKey,
        telegramUserId: telegramUserId || (playerKey?.startsWith("tg:") ? playerKey.slice(3) : null),
        username,
        verified: !!verifiedTelegramUser
    };
}

// Every player gets a private game-session room inside the selected game type.
// The public room (vip/superbingo/Edilbingo) is still used for synchronized
// bingo draws, while this private room keeps player-specific state/events isolated.
function getPlayerGameRoomId(roomId, playerKey) {
    const safeKey = String(playerKey || "player").replace(/[^a-zA-Z0-9:_-]/g, "_");
    return `${roomId}:player:${safeKey}`;
}

// Private state for one player's playing room. This deliberately never
// contains the other players' lottery/cartella numbers or player list.
// Canonicalize older in-memory VIP tickets so the same Telegram account
// always owns the same tickets on every device. Older tickets may have been
// created before telegramUserId/username was stored on the ticket itself.
function syncTicketOwnershipToTelegramAccount(room, identity) {
    if (!room || !identity?.playerKey) return;
    const telegramId = identity.telegramUserId ? String(identity.telegramUserId) : null;
    const username = identity.username ? String(identity.username).trim().toLowerCase().replace(/^@/, "") : null;
    if (!telegramId && !username) return;

    for (const ticket of room.tickets.values()) {
        const ticketTelegramId = ticket.telegramUserId ? String(ticket.telegramUserId) : null;
        const ticketUsername = ticket.username ? String(ticket.username).trim().toLowerCase().replace(/^@/, "") : null;
        let match = false;

        if (telegramId && ticketTelegramId === telegramId) match = true;
        if (!match && username && ticketUsername === username) match = true;

        // Compatibility with tickets created before ticket-level identity was stored:
        // use the room player record that originally created the ticket.
        if (!match && ticket.ownerKey) {
            const ownerPlayer = Array.from(room.players.values()).find(p => p.playerKey === ticket.ownerKey);
            if (ownerPlayer) {
                if (telegramId && ownerPlayer.telegramUserId && String(ownerPlayer.telegramUserId) === telegramId) match = true;
                if (!match && username && ownerPlayer.username && String(ownerPlayer.username).trim().toLowerCase().replace(/^@/, "") === username) match = true;
            }
        }

        if (match) {
            ticket.ownerKey = identity.playerKey;
            ticket.telegramUserId = telegramId;
            ticket.username = username;
            const sold = room.soldNumbers.get(ticket.ticketNumber);
            if (sold) {
                sold.ownerKey = identity.playerKey;
                sold.telegramUserId = telegramId;
                sold.username = username;
            }
        }
    }
}

function getPrivateRoomState(room, playerKey) {
    if (!room) return null;

    const ownTickets = Array.from(room.tickets.values())
        .filter(ticket => ticket.ownerKey === playerKey);

    return {
        roomId: room.id,
        roomName: room.name,
        roundNumber: room.roundNumber || 1,
        registrationCode: room.registrationCode || "00000",
        entryFee: room.entryFee,
        gameStarted: room.gameStarted,
        calledNumbers: [...room.calledNumbers],
        totalCalled: room.calledNumbers.length,
        remainingNumbers: 75 - room.calledNumbers.length,
        // Only this player's lottery/cartella numbers are exposed here.
        myLotteryNumbers: ownTickets.map(ticket => ticket.ticketNumber),
        myCards: ownTickets.map(ticket => ({
            ticketNumber: ticket.ticketNumber,
            card: ticket.card,
            markedCells: Array.from(ticket.markedCells || []),
            confirmed: ticket.confirmed !== false
        })),
        players: ownTickets.length ? 1 : 0,
        phase: room.gameStarted ? "playing" : "buying",
        bingoClaimOpenUntil: room.bingoClaimOpenUntil || null,
        derash: room.entryFee > 0 ? room.soldNumbers.size * room.entryFee * 0.8 : 0
    };
}

function emitToPrivatePlayerRooms(room, event, payloadFactory) {
    if (!room) return;

    // A single Telegram account may have multiple devices/sockets open at
    // the same time. They intentionally share one playerKey and therefore
    // one private Socket.IO room. Emit once per account room so every device
    // receives exactly the same game state without duplicate events.
    const sentKeys = new Set();
    for (const player of room.players.values()) {
        const playerKey = player.playerKey;
        if (!playerKey || sentKeys.has(playerKey)) continue;
        sentKeys.add(playerKey);

        const playerRoomId = getPlayerGameRoomId(room.id, playerKey);
        const payload = typeof payloadFactory === "function"
            ? payloadFactory(player)
            : payloadFactory;
        io.to(playerRoomId).emit(event, payload);
    }
}

// Push the complete account-specific room state to every device belonging
// to the same Telegram account. This is used after a purchase, cancellation,
// lucky-number change, or any other account-owned card update.
function syncPlayerAccountRoom(room, playerKey) {
    if (!room || !playerKey) return;

    const playerRoomId = getPlayerGameRoomId(room.id, playerKey);
    const accountPlayer = Array.from(room.players.values()).find(p => p.playerKey === playerKey);
    const telegramUserId = accountPlayer?.telegramUserId || null;
    const account = getDepositedAccount(telegramUserId, playerKey, room.id);
    const ownTickets = Array.from(room.tickets.values())
        .filter(ticket => ticket.ownerKey === playerKey)
        .map(ticket => ({
            ticketNumber: ticket.ticketNumber,
            card: ticket.card,
            playerName: ticket.playerName,
            markedCells: Array.from(ticket.markedCells || []),
            confirmed: ticket.confirmed !== false
        }));

    io.to(playerRoomId).emit("accountBalance", {
        available: account.available,
        balance: account.available ? account.balance : 0
    });

    io.to(playerRoomId).emit("myCards", {
        roomId: room.id,
        cards: ownTickets,
        gameStarted: room.gameStarted,
        myLuckySelectionEndsAt: room.id === "superbingo"
            ? (room.superbingoSelectionDeadlines?.get(playerKey) || null)
            : null
    });

    io.to(playerRoomId).emit("roomState", getRoomState(room, playerKey));
    io.to(playerRoomId).emit("playerRoomState", getPrivateRoomState(room, playerKey));
}

const demoBalances = new Map();

function getBalanceKey(telegramUserId, playerKey, roomId) {
    // The Telegram account is the canonical wallet owner.  Never use the
    // device/socket playerKey for the balance, because the same Telegram
    // account can open VIP and SuperBingo (or multiple devices) with
    // different player keys.  roomId is intentionally ignored so every room
    // displays the exact same deposited/available balance.
    const telegramId = telegramUserId ? String(telegramUserId) : null;
    const baseKey = telegramId ? `tg:${telegramId}` : (playerKey || null);
    return baseKey ? `${baseKey}:global` : null;
}

function getDepositedAccount(telegramUserId, playerKey = null, roomId = null) {
    const key = getBalanceKey(telegramUserId, playerKey, roomId);
    const startingBalance = DEMO_FIXED_BALANCE;

    if (!key) return { available: true, balance: startingBalance, userId: null };

    if (!demoBalances.has(key)) {
        const telegramId = telegramUserId ? String(telegramUserId) : null;
        const dbUser = telegramId ? db.prepare("SELECT id, balance FROM users WHERE telegram_id = ? LIMIT 1").get(telegramId) : null;
        const dbBalance = Number(dbUser?.balance);

        const initialBalance = Number.isFinite(dbBalance) && dbBalance > 0 ? dbBalance : startingBalance;
        demoBalances.set(key, initialBalance);
        if (dbUser && (!Number.isFinite(dbBalance) || dbBalance <= 0)) {
            db.prepare("UPDATE users SET balance = ? WHERE id = ?").run(initialBalance, dbUser.id);
        }
    }
    return { available: true, balance: Number(demoBalances.get(key) || 0), userId: telegramUserId ? String(telegramUserId) : null };
}

function persistAccountBalance(telegramUserId, balance) {
    if (!telegramUserId) return;
    const value = Math.max(0, Number(balance) || 0);
    db.prepare("UPDATE users SET balance = ? WHERE telegram_id = ?").run(value, String(telegramUserId));
}

function setAccountBalance(telegramUserId, playerKey, balance) {
    const value = Math.max(0, Number(balance) || 0);
    const telegramId = telegramUserId ? String(telegramUserId) : null;
    const key = getBalanceKey(telegramId, playerKey, null);
    if (key) demoBalances.set(key, value);
    persistAccountBalance(telegramId, value);

    // Push the same wallet value to every open room/device belonging to this
    // Telegram account. This makes a deposit, purchase, win, cancellation or
    // approved withdrawal appear consistently in VIP and SuperBingo without
    // waiting for the player to reload the page.
    if (telegramId) {
        for (const room of Object.values(rooms)) {
            for (const player of room.players.values()) {
                if (String(player.telegramUserId || "") !== telegramId) continue;
                player.balance = value;
                player.balanceAvailable = true;
                const privateRoomId = getPlayerGameRoomId(room.id, player.playerKey);
                io.to(privateRoomId).emit("accountBalance", {
                    available: true,
                    balance: value
                });
            }
        }
    }

    return value;
}


// ============================================================
// ROOM STATE
// ============================================================

function getRoomState(room, socketPlayerKeyForState = null) {

    if (!room) {
        return null;
    }

    return {

        roomId: room.id,

        roomName: room.name,
        roundNumber: room.roundNumber || 1,
        registrationCode: room.registrationCode || "00000",

        entryFee: room.entryFee,

        lotteryNumbers: room.lotteryNumbers,
        availableLotteryNumbers: Math.max(0, room.lotteryNumbers - room.soldNumbers.size),

        gameStarted: room.gameStarted,

        // Server-authoritative selection clock. All players in the same
        // round share one start/end time. serverNow lets clients compensate
        // for differences between device clocks.
        buyingStartedAt: room.buyingStartedAt || null,
        buyingEndsAt: room.buyingEndsAt || null,
        serverNow: Date.now(),
        scheduledStartAt: room.scheduledStartAt || null,
        scheduledDays: room.id === "superbingo" ? ["Tuesday", "Thursday", "Saturday", "Sunday"] : null,
        scheduledTime: room.id === "superbingo" ? "Tue 04:20, Thu/Sat/Sun 11:00 EAT" : null,
        myLuckySelectionEndsAt: room.id === "superbingo" && socketPlayerKeyForState ? (room.superbingoSelectionDeadlines.get(socketPlayerKeyForState) || null) : null,

        calledNumbers: [
            ...room.calledNumbers
        ],

        totalCalled:
            room.calledNumbers.length,

        remainingNumbers:
            75 - room.calledNumbers.length,

        soldNumbers:
            Array.from(
                room.soldNumbers.keys()
            ),

        soldCount:
            room.soldNumbers.size,

        players:
            room.players.size,

        phase: room.gameStarted ? "playing" : "buying",

        // A player may claim Bingo only during the window created by the latest draw.
        bingoClaimOpenUntil: room.bingoClaimOpenUntil || null,

        derash: room.entryFee > 0 ? room.soldNumbers.size * room.entryFee * 0.8 : 0

    };

}

// ============================================================
// BINGO LETTER
// ============================================================

function getLetter(number) {

    if (number >= 1 && number <= 15) {
        return "B";
    }

    if (number >= 16 && number <= 30) {
        return "I";
    }

    if (number >= 31 && number <= 45) {
        return "N";
    }

    if (number >= 46 && number <= 60) {
        return "G";
    }

    if (number >= 61 && number <= 75) {
        return "O";
    }

    return "";

}

// ============================================================
// DRAW NUMBER
// ============================================================

function drawNumber(room) {

    if (!room) {
        return null;
    }

    if (room.calledNumbers.length >= 75) {
        return null;
    }

    let number;

    do {

        number =
            Math.floor(
                Math.random() * 75
            ) + 1;

    } while (
        room.calledNumbers.includes(number)
    );

    room.calledNumbers.push(number);

    return number;

}

// ============================================================
// DRAW RESULT
// ============================================================

function createDrawResult(room, number) {

    const letter =
        getLetter(number);

    return {

        roomId: room.id,

        number: number,

        letter: letter,

        display:
            `${letter}-${number}`,

        totalCalled:
            room.calledNumbers.length,

        remaining:
            75 -
            room.calledNumbers.length

    };

}

// ============================================================
// PERFORM DRAW
// ============================================================

function performDraw(roomId) {

    const room =
        getRoom(roomId);

    if (!room) {

        return {

            success: false,

            message:
                "Room not found."

        };

    }

    if (!room.gameStarted) {

        return {

            success: false,

            message:
                "Game has not started."

        };

    }

    // SuperBingo may draw balls only after its scheduled date/time.
    // This guard also protects the manual /draw API and Telegram /draw.
    if (room.id === "superbingo") {
        const scheduled = Number(
            room.activeScheduledStartAt ||
            room.scheduledStartAt ||
            0
        );
        // Hard server-side gate: no SuperBingo ball can ever be drawn before
        // the exact scheduled EAT timestamp, regardless of how the draw was
        // triggered (automatic timer, Telegram /draw, HTTP API, or socket).
        if (
            !room.superbingoDrawAuthorized ||
            !Number.isFinite(scheduled) ||
            scheduled <= 0 ||
            Date.now() < scheduled
        ) {
            room.gameStarted = false;
            stopAutoDraw(room.id);
            room.calledNumbers = [];
            return {
                success: false,
                message: "SuperBingo is waiting for its scheduled date and time."
            };
        }
    }

    const number =
        drawNumber(room);

    if (number === null) {

        return {

            success: false,

            message:
                "All 75 numbers have been called."

        };

    }

    const result =
        createDrawResult(
            room,
            number
        );

    // Each drawn ball opens a Bingo-claim window that lasts until the
    // next automatic draw. The player must complete a line and press
    // BINGO before the next ball is called.
    room.bingoClaimOpenUntil = Date.now() + AUTO_DRAW_INTERVAL_MS;

    // VIP drawing continues to work, but its individual draw events are
    // intentionally not printed to the server console.
    if (room.id !== "vip") {
        console.log(
            `NUMBER DRAWN [${room.name}]: ${result.display}`
        );
    }

    // IMPORTANT: draw events are delivered to each player's PRIVATE
    // playing room. Other players must not receive another player's
    // playing-room stream.
    emitToPrivatePlayerRooms(room, "numberCalled", result);
    emitToPrivatePlayerRooms(room, "playerRoomState", player =>
        getPrivateRoomState(room, player.playerKey)
    );

    // The public room state is still used by the buying/lobby screen.
    // It contains only the sold-number list needed to prevent duplicate
    // lottery-number selection.
    io.to(room.id).emit("roomState", getRoomState(room));

    // After the 75th ball, the round is complete. Stop drawing, notify
    // playing-room clients to return to the selection/buying room, then
    // reset the room for the next round.
    if (room.calledNumbers.length >= 75) {
        stopAutoDraw(room.id);

        emitToPrivatePlayerRooms(
            room,
            "returnToSelectionRoom",
            player => getPrivateRoomState(room, player.playerKey)
        );

        resetRoom(room);
        // Immediately start the next selection window, even when the
        // completed round had no players. Keep the room cycle continuous.
        scheduleAutoStart(room.id);
        broadcastRoomState(room);

        console.log(
            `75 BALLS COMPLETE [${room.name}] - returned to selection room and next selection cycle scheduled`
        );
    }

    return {

        success: true,

        ...result

    };

}

// ============================================================
// RESET ROOM
// ============================================================

function resetRoom(room) {
    if (!room) return;
    room.roundNumber = (room.roundNumber || 1) + 1;
    room.registrationCode = createRegistrationCode();
    room.calledNumbers = [];
    room.gameStarted = false;
    room.buyingStartedAt = null;
    room.buyingEndsAt = null;
    room.scheduledStartAt = null;
    room.activeScheduledStartAt = null;
    room.lastScheduledStartAt = null;
    room.superbingoDrawAuthorized = false;
    room.bingoClaimOpenUntil = null;
    if (room.superbingoSelectionDeadlines) room.superbingoSelectionDeadlines.clear();
    room.soldNumbers.clear();
    room.tickets.clear();
    // A new round gets a fresh set of unique Bingo cards.
    room.usedCardSignatures.clear();
    room.roundTransition = false;
}

// ============================================================
// SERIALIZE PLAYERS
// ============================================================

function serializePlayers(room) {

    return Array.from(
        room.players.values()
    ).map(player => {

        return {

            socketId:
                player.socketId,

            name:
                player.name,

            telegramUserId:
                player.telegramUserId || null,

            username:
                player.username || null

        };

    });

}

// ============================================================
// BROADCAST ROOM STATE
// ============================================================

function broadcastRoomState(room) {

    if (!room) {
        return;
    }

    io.to(room.id).emit(
        "roomState",
        getRoomState(room)
    );

    io.to(room.id).emit(
        "playersUpdated",
        {

            count:
                room.players.size

        }
    );

}

// ============================================================
// API - ROOMS
// ============================================================

app.get(
    "/api/rooms",
    (req, res) => {

        const result =
            Object.values(rooms)
                .map(room => {

                    return {

                        id:
                            room.id,

                        name:
                            room.name,

                        entryFee:
                            room.entryFee,

                        gameStarted:
                            room.gameStarted,

                        players:
                            room.players.size,

                        soldCount:
                            room.soldNumbers.size

                    };

                });

        res.json({

            success: true,

            rooms: result

        });

    }
);

// ============================================================
// API - STATUS
// ============================================================

app.get(
    "/api/status",
    (req, res) => {

        const roomId =
            req.query.room ||
            DEFAULT_ROOM;

        const room =
            getRoom(roomId);

        if (!room) {

            return res
                .status(404)
                .json({

                    success: false,

                    message:
                        "Room not found."

                });

        }

        res.json({

            success: true,

            game:
                "EDILBINGO",

            room:
                getRoomState(room)

        });

    }
);

// ============================================================
// API - START GAME
// ============================================================

app.post(
    "/api/start-game",
    (req, res) => {

        const roomId =
            req.body.roomId ||
            DEFAULT_ROOM;

        const room =
            getRoom(roomId);

        if (!room) {

            return res
                .status(404)
                .json({

                    success: false,

                    message:
                        "Room not found."

                });

        }

        if (room.id === BONUS_ROOM_ID) {
            return res.status(400).json({
                success: false,
                message: "GoodBingo Bonus is a dedicated prediction room and does not use Bingo drawing."
            });
        }

        if (room.soldNumbers.size === 0 && room.entryFee > 0) {
            return res.status(400).json({
                success: false,
                message: "No lottery cards have been purchased yet."
            });
        }

        if (room.id === "superbingo") {
            const scheduled = Number(room.scheduledStartAt || getNextSuperBingoStart().getTime());
            if (!Number.isFinite(scheduled) || Date.now() < scheduled) {
                room.scheduledStartAt = scheduled;
                room.buyingEndsAt = scheduled;
                scheduleAutoStart(room.id);
                return res.status(400).json({
                    success: false,
                    message: "SuperBingo starts only at the scheduled date and time.",
                    scheduledStartAt: scheduled
                });
            }
        }

        room.gameStarted = true;
        room.calledNumbers = [];
        room.bingoClaimOpenUntil = null;
        startAutoDraw(room.id);

        console.log(
            `GAME STARTED [${room.name}] — AUTO DRAW EVERY ${AUTO_DRAW_INTERVAL_MS}ms`
        );

        io.to(room.id).emit(
            "gameStarted",
            getRoomState(room)
        );

        broadcastRoomState(room);

        res.json({

            success: true,

            message:
                `${room.name} game started.`,

            room:
                getRoomState(room)

        });

    }
);

// ============================================================
// API - DRAW NUMBER
// ============================================================

app.post(
    "/api/draw-number",
    (req, res) => {

        const roomId =
            req.body.roomId ||
            DEFAULT_ROOM;

        const result =
            performDraw(roomId);

        if (!result.success) {

            return res
                .status(400)
                .json(result);

        }

        res.json(result);

    }
);

// ============================================================
// API - NEW GAME
// ============================================================

app.post(
    "/api/new-game",
    (req, res) => {

        const roomId =
            req.body.roomId ||
            DEFAULT_ROOM;

        const room =
            getRoom(roomId);

        if (!room) {

            return res
                .status(404)
                .json({

                    success: false,

                    message:
                        "Room not found."

                });

        }

        resetRoom(room);
        scheduleAutoStart(room.id);

        console.log(
            `NEW GAME [${room.name}]`
        );

        io.to(room.id).emit(
            "newGameStarted",
            getRoomState(room)
        );

        broadcastRoomState(room);

        res.json({

            success: true,

            message:
                `${room.name} new game started.`,

            room:
                getRoomState(room)

        });

    }
);

// ============================================================
// API - STOP GAME
// ============================================================

app.post(
    "/api/stop-game",
    (req, res) => {

        const roomId =
            req.body.roomId ||
            DEFAULT_ROOM;

        const room =
            getRoom(roomId);

        if (!room) {

            return res
                .status(404)
                .json({

                    success: false,

                    message:
                        "Room not found."

                });

        }

        room.gameStarted = false;

        console.log(
            `GAME STOPPED [${room.name}]`
        );

        io.to(room.id).emit(
            "gameStopped",
            getRoomState(room)
        );

        broadcastRoomState(room);

        res.json({

            success: true,

            message:
                `${room.name} game stopped.`,

            room:
                getRoomState(room)

        });

    }
);

// ============================================================
// SOCKET.IO
// ============================================================

io.on(
    "connection",
    (socket) => {

        console.log(
            "Player connected:",
            socket.id
        );

        // Return the authoritative server clock. Clients use the midpoint
        // of the request/response to compensate for device-clock differences.
        socket.on("timeSync", (clientSentAt, callback) => {
            if (typeof callback === "function") callback({
                clientSentAt: Number(clientSentAt) || 0,
                serverNow: Date.now()
            });
        });

        // ====================================================
        // JOIN ROOM
        // ====================================================

        socket.on(
            "joinRoom",
            (data, oldPlayerData) => {

                let roomId;

                let name;

                let telegramUserId;

                let username;

                let telegramInitData;
                let playerId;

                // ------------------------------------------------
                // OLD FORMAT
                //
                // socket.emit("joinRoom", "vip", {
                //     name: "Player"
                // });
                // ------------------------------------------------

                if (
                    typeof data === "string"
                ) {

                    roomId = data;

                    name =
                        oldPlayerData?.name ||
                        "Player";

                    telegramUserId =
                        oldPlayerData?.telegramUserId ||
                        null;

                    username =
                        oldPlayerData?.username ||
                        null;

                    telegramInitData =
                        oldPlayerData?.telegramInitData ||
                        null;

                    playerId =
                        oldPlayerData?.playerId ||
                        null;

                }

                // ------------------------------------------------
                // NEW FORMAT
                //
                // socket.emit("joinRoom", {
                //     roomId: "vip",
                //     name: "Player"
                // });
                // ------------------------------------------------

                else {

                    roomId =
                        data?.roomId;

                    name =
                        data?.name;

                    telegramUserId =
                        data?.telegramUserId;

                    username =
                        data?.username;

                    telegramInitData =
                        data?.telegramInitData;

                    playerId =
                        data?.playerId;

                }

                roomId =
                    roomId ||
                    DEFAULT_ROOM;

                const requestedMode = data?.mode || oldPlayerData?.mode || "buying";

                let room =
                    getRoom(roomId);

                if (!room) {

                    socket.emit(
                        "roomError",
                        "Room not found."
                    );

                    socket.emit(
                        "errorMessage",
                        "Room not found."
                    );

                    return;

                }

                // GoodBingo Bonus is intentionally isolated from the Bingo
                // Socket.IO rooms. The only entry point is /goodbingo-room.html.
                if (room.id === BONUS_ROOM_ID) {
                    socket.emit("roomError", "GoodBingo Bonus is a dedicated prediction room.");
                    socket.emit("errorMessage", "Open the GoodBingo Bonus menu to enter the dedicated prediction room.");
                    return;
                }

                
                // Establish the canonical account identity BEFORE reading the
                // account or checking cartella ownership. Telegram initData is
                // verified server-side when available, so the same Telegram
                // account on different devices resolves to the same playerKey.
                const identity = resolvePlayerIdentity({
                    telegramUserId,
                    username,
                    telegramInitData,
                    playerId,
                    name
                }, room);

                const finalPlayerKey = identity.playerKey;
                telegramUserId = identity.telegramUserId || telegramUserId || null;
                username = identity.username || username || null;

                ensureTelegramAccountRecord(
                    telegramUserId,
                    username,
                    identity.verified ? (data?.name || null) : null
                );

                // IMPORTANT: before checking ownership, reconcile any existing
                // tickets created under an older device/session identity with the
                // canonical Telegram account. This is what makes VIP selection and
                // VIP playing identical across devices for the same account.
                syncTicketOwnershipToTelegramAccount(room, identity);

                // Account-level room affinity: when a player is opening a
                // playing room on another device, use the room currently owned
                // by that Telegram account. This prevents the generic playing
                // URL from silently defaulting the second device to VIP.
                if (requestedMode === "playing" && telegramUserId) {
                    const activeRoomId = getAccountActiveRoom(telegramUserId);
                    if (activeRoomId && activeRoomId !== room.id) {
                        const requestedRoomId = room.id;
                        room = getRoom(activeRoomId);
                        socket.emit("roomRedirect", {
                            roomId: activeRoomId,
                            requestedRoomId,
                            reason: "same-telegram-account-active-room"
                        });
                        console.log(
                            `ROOM REDIRECT [same Telegram account] ${telegramUserId}: ${requestedRoomId} -> ${activeRoomId}`
                        );
                    }
                }

                if (!finalPlayerKey) {
                    socket.emit("roomError", "Player identity is required. Open the game from your registered account.");
                    socket.emit("errorMessage", "Player identity is required. Open the game from your registered account.");
                    return;
                }

                // Balance is authoritative only when the player has a completed
                // deposit recorded in the account database. Never trust the
                // browser/localStorage balance for room access or purchases.
                const account = getDepositedAccount(telegramUserId, finalPlayerKey, room.id);
                const joinBalance = account.available ? account.balance : 0;

                // A player needs the room minimum balance to SELECT/BUY a
                // cartella. After successfully buying a cartella, the balance
                // may fall below the minimum (for example 10 -> 0 in VIP).
                // Such a player must still be allowed into the playing room
                // when the countdown reaches zero, because they already own
                // a cartella for this round.
                const ownsCurrentRoundTicket = Array.from(room.tickets.values())
                    .some(ticket => ticket.ownerKey === finalPlayerKey);

                // Playing-room access is allowed to every registered player once the
                // round is already in progress. Players who own a cartella receive only
                // their own private card; players who did not select a cartella are
                // spectators and see the game/draw screen with a waiting message.
                // The buying page remains subject to the normal balance rules.
                // Once a round has already started, let everyone enter the room as a
                // spectator. Players who selected a cartella can play normally; players
                // who missed the buying window will see the "GAME IN PROGRESS" overlay
                // and must wait for the next buying round. Balance requirements are still
                // enforced when purchasing a cartella before the game starts.
                if (!room.gameStarted && (room.id === "vip" || room.id === "superbingo")) {
                    if (!account.available) {
                        const minimum = room.id === "vip" ? VIP_MIN_BALANCE : SUPERBINGO_MIN_BALANCE;
                        socket.emit("roomError", `Deposit at least ${minimum} Birr into your account before playing ${room.name}.`);
                        socket.emit("errorMessage", `Deposit at least ${minimum} Birr into your account before playing ${room.name}.`);
                        return;
                    }
                    if (room.id === "vip" && joinBalance < VIP_MIN_BALANCE) {
                        socket.emit("roomError", "VIP room requires a minimum deposited balance of 10 Birr.");
                        socket.emit("errorMessage", "VIP room requires a minimum deposited balance of 10 Birr.");
                        return;
                    }
                    if (room.id === "superbingo" && joinBalance < SUPERBINGO_MIN_BALANCE) {
                        socket.emit("roomError", "SuperBingo requires a minimum deposited balance of 50 Birr.");
                        socket.emit("errorMessage", "SuperBingo requires a minimum deposited balance of 50 Birr.");
                        return;
                    }
                }
name =
                    String(
                        name ||
                        "Player"
                    ).trim();

                if (
                    name.length === 0
                ) {

                    name = "Player";

                }

                const playerGameRoomId = getPlayerGameRoomId(room.id, finalPlayerKey);

                // ------------------------------------------------
                // LEAVE PREVIOUS ROOM
                // ------------------------------------------------

                if (
                    socket.data.roomId
                ) {

                    const oldRoom =
                        getRoom(
                            socket.data.roomId
                        );

                    if (oldRoom) {

                        oldRoom.players.delete(
                            socket.id
                        );

                        socket.leave(
                            oldRoom.id
                        );

                        if (socket.data.playerGameRoomId) {
                            socket.leave(socket.data.playerGameRoomId);
                        }

                        broadcastRoomState(
                            oldRoom
                        );

                    }

                }

                // ------------------------------------------------
                // JOIN NEW ROOM
                // ------------------------------------------------

                // Public game room: all players in this room share the same draw.
                socket.join(room.id);

                // Private player room: this player's cartella/balance/session events
                // remain isolated from other players.
                socket.join(playerGameRoomId);

                socket.data.roomId =
                    room.id;

                socket.data.playerGameRoomId =
                    playerGameRoomId;

                socket.data.playerName =
                    name;

                socket.data.telegramUserId =
                    telegramUserId ||
                    null;

                socket.data.username =
                    username ||
                    null;

                socket.data.playerId =
                    playerId ||
                    null;

                socket.data.telegramInitData =
                    telegramInitData ||
                    null;

                socket.data.playerKey = finalPlayerKey;

                // ------------------------------------------------
                // SAVE PLAYER
                // ------------------------------------------------

                room.players.set(
                    socket.id,
                    {

                        socketId:
                            socket.id,

                        name:
                            name,

                        telegramUserId:
                            telegramUserId ||
                            null,

                        username:
                            username ||
                            null,

                        playerKey:
                            socket.data.playerKey,

                         balance:
                             account.available ? account.balance : 0,

                         balanceAvailable:
                             account.available,

                         accountUserId:
                             account.userId

                    }
                );

                // Keep VIP player-join activity out of the server console.
                // Other room join logs remain unchanged.
                if (room.id !== "vip") {
                    console.log(
                        `${name} joined ${room.name} | account=${finalPlayerKey} | telegramVerified=${identity.verified}`
                    );
                }

                // Send the private account balance only to this player.
                // The balance is visible only when the account has at least
                // one completed deposit transaction.
                socket.emit("accountBalance", {
                    available: account.available,
                    balance: account.available ? account.balance : 0
                });

                // SECURITY/PRIVACY: do NOT send the private player-room ID or
                // player key to the browser. The server keeps these values in
                // socket.data and uses them internally for private Socket.IO
                // delivery. Other players therefore cannot discover another
                // player's private room identifier from the client.

                // ------------------------------------------------
                // SEND INITIAL ROOM STATE
                // ------------------------------------------------

                // Start/synchronize the buying countdown as soon as a player enters
                // a fresh buying room. The server remains authoritative.
                if (!room.gameStarted) {
                    scheduleAutoStart(room.id);
                }

                socket.emit(
                    "roomState",
                    getRoomState(room, finalPlayerKey)
                );

                // Private playing-room state: only this player's own
                // cartella/lottery numbers are included.
                socket.emit(
                    "playerRoomState",
                    getPrivateRoomState(room, finalPlayerKey)
                );

                        // If the same Telegram account opens this room on another device,
                // Telegram supplies the same user.id. The server therefore resolves
                // both devices to the same playerKey/private room and immediately
                // sends that account's existing cartella cards to the new device.
                const myCards = Array.from(room.tickets.values())
                    .filter(ticket => ticket.ownerKey === finalPlayerKey)
                    .map(ticket => ({
                        ticketNumber: ticket.ticketNumber,
                        card: ticket.card,
                        playerName: ticket.playerName,
                        markedCells: Array.from(ticket.markedCells || []),
                    confirmed: ticket.confirmed !== false
                }));
                socket.emit("myCards", {
                    roomId: room.id,
                    cards: myCards,
                    gameStarted: room.gameStarted
                });

                socket.emit(
                    "playersUpdated",
                    {
                        count: room.players.size
                    }
                );

                broadcastRoomState(room);

            }
        );

        // ====================================================
        // START GAME
        // ====================================================

        socket.on(
            "startGame",
            () => {

                const room =
                    getRoom(
                        socket.data.roomId ||
                        DEFAULT_ROOM
                    );

                if (!room) {
                    return;
                }

                if (room.soldNumbers.size === 0 && room.entryFee > 0) {
                    socket.emit("errorMessage", "No lottery cards have been purchased yet.");
                    return;
                }
                if (room.id === "superbingo") {
                    const scheduled = Number(room.scheduledStartAt || getNextSuperBingoStart().getTime());
                    room.scheduledStartAt = scheduled;
                    room.buyingEndsAt = scheduled;
                    if (!Number.isFinite(scheduled) || Date.now() < scheduled) {
                        scheduleAutoStart(room.id);
                        socket.emit("errorMessage", "SuperBingo starts only at the scheduled date and time.");
                        return;
                    }
                }
                room.gameStarted = true;
                room.calledNumbers = [];
                startAutoDraw(room.id);

                console.log(
                    `GAME STARTED [${room.name}] — AUTO DRAW EVERY ${AUTO_DRAW_INTERVAL_MS}ms`
                );

                emitToPrivatePlayerRooms(room, "gameStarted", player =>
                    getPrivateRoomState(room, player.playerKey)
                );

                broadcastRoomState(room);

            }
        );

        // ====================================================
        // DRAW NUMBER
        // ====================================================

        socket.on(
            "drawNumber",
            () => {

                const roomId =
                    socket.data.roomId ||
                    DEFAULT_ROOM;

                const result =
                    performDraw(roomId);

                if (!result.success) {

                    socket.emit(
                        "errorMessage",
                        result.message
                    );

                }

            }
        );

        // ====================================================
        // NEW GAME
        // ====================================================

        socket.on(
            "newGame",
            () => {

                const room =
                    getRoom(
                        socket.data.roomId ||
                        DEFAULT_ROOM
                    );

                if (!room) {
                    return;
                }

                if (room.id === BONUS_ROOM_ID) {
                    socket.emit("errorMessage", "GoodBingo Bonus does not use the Bingo game engine.");
                    return;
                }

                stopAutoDraw(room.id);
                stopAutoStart(room.id);
                resetRoom(room);
                scheduleAutoStart(room.id);

                console.log(
                    `NEW GAME [${room.name}]`
                );

                emitToPrivatePlayerRooms(room, "newGameStarted", player =>
                    getPrivateRoomState(room, player.playerKey)
                );

                broadcastRoomState(room);

            }
        );

        // ====================================================
        // STOP GAME
        // ====================================================

        socket.on(
            "stopGame",
            () => {

                const room =
                    getRoom(
                        socket.data.roomId ||
                        DEFAULT_ROOM
                    );

                if (!room) {
                    return;
                }

                room.gameStarted = false;
                stopAutoDraw(room.id);
                stopAutoStart(room.id);

                console.log(
                    `GAME STOPPED [${room.name}]`
                );

                emitToPrivatePlayerRooms(room, "gameStopped", player =>
                    getPrivateRoomState(room, player.playerKey)
                );

                broadcastRoomState(room);

            }
        );

        // ====================================================
        // BUY NUMBERS
        // ====================================================

function uniqueCountLimitExceeded(numbers) {
    if (!Array.isArray(numbers)) return false;
    return new Set(numbers.map(Number)).size > 2;
}

        socket.on(
            "buyNumbers",
            (data) => {

                const room =
                    getRoom(
                        socket.data.roomId ||
                        data?.roomId ||
                        DEFAULT_ROOM
                    );

                if (!room) {

                    socket.emit(
                        "purchaseError",
                        "Room not found."
                    );

                    return;

                }

                if (room.gameStarted) {
                    socket.emit("purchaseError", "Buying is closed. The game is already in progress.");
                    return;
                }

                // SuperBingo gives each player one 30-second window from their
                // first lucky-number selection. The window is server-authoritative.
                const superOwnerKey = socket.data.playerKey || getPlayerKey({
                    telegramUserId: data?.telegramUserId,
                    username: data?.username,
                    name: socket.data.playerName || data?.playerName || "Player"
                });
                if (room.id === "superbingo") {
                    const existingDeadline = Number(room.superbingoSelectionDeadlines?.get(superOwnerKey) || 0);
                    if (existingDeadline && Date.now() >= existingDeadline) {
                        socket.emit("purchaseError", "The 30-second SuperBingo selection window is closed.");
                        return;
                    }
                }

                
                // Never trust a balance supplied by the browser. Read the
                // player's account and completed deposits from the database.
                const accountBeforePurchase = getDepositedAccount(socket.data.telegramUserId, socket.data.playerKey, room.id);
                const currentBalance = accountBeforePurchase.available ? accountBeforePurchase.balance : 0;
                if ((room.id === "vip" || room.id === "superbingo") && !accountBeforePurchase.available) {
                    const minimum = room.id === "vip" ? VIP_MIN_BALANCE : SUPERBINGO_MIN_BALANCE;
                    socket.emit("purchaseError", `Deposit at least ${minimum} Birr into your account before playing ${room.name}.`);
                    return;
                }
                if (room.id === "vip" && currentBalance < VIP_MIN_BALANCE) {
                    socket.emit("purchaseError", "You need at least 10 Birr of deposited balance to play VIP.");
                    return;
                }
                if (room.id === "superbingo" && currentBalance < SUPERBINGO_MIN_BALANCE) {
                    socket.emit("purchaseError", "You need at least 50 Birr of deposited balance to play SuperBingo.");
                    return;
                }
if (uniqueCountLimitExceeded(data?.numbers)) {
                    socket.emit("purchaseError", "You can select a maximum of 2 lucky numbers.");
                    return;
                }

                // Enforce the maximum across all purchases in this round,
                // not just within a single socket request.
                const ownerKeyForLimit = socket.data.playerKey || getPlayerKey({
                    telegramUserId: data?.telegramUserId,
                    username: data?.username,
                    name: socket.data.playerName || data?.playerName || "Player"
                });
                const ownedCount = Array.from(room.tickets.values())
                    .filter(ticket => ticket.ownerKey === ownerKeyForLimit)
                    .length;

                const requestedUniqueCount = Array.isArray(data?.numbers)
                    ? new Set(data.numbers.map(Number)).size
                    : 0;

                if (ownedCount + requestedUniqueCount > 2) {
                    socket.emit("purchaseError", "You can select a maximum of 2 lucky numbers.");
                    return;
                }

                const numbers =
                    Array.isArray(
                        data?.numbers
                    )
                        ? data.numbers
                        : [];

                if (
                    numbers.length === 0
                ) {

                    socket.emit(
                        "purchaseError",
                        "No numbers selected."
                    );

                    return;

                }

                // ------------------------------------------------
                // REMOVE DUPLICATES
                // ------------------------------------------------

                const uniqueNumbers =
                    [
                        ...new Set(
                            numbers.map(
                                Number
                            )
                        )
                    ];

                // ------------------------------------------------
                // VALIDATE NUMBERS
                // ------------------------------------------------

                const invalid =
                    uniqueNumbers.some(
                        number =>

                            !Number.isInteger(
                                number
                            ) ||

                            number < 1 ||

                            number > room.lotteryNumbers
                    );

                if (invalid) {

                    socket.emit(
                        "purchaseError",
                        `Invalid lottery number. Select a number from 1 to ${room.lotteryNumbers}.`
                    );

                    return;

                }

                // ------------------------------------------------
                // CHECK SOLD NUMBERS
                // ------------------------------------------------

                const alreadySold =
                    uniqueNumbers.filter(
                        number =>
                            room.soldNumbers.has(
                                number
                            )
                    );

                if (
                    alreadySold.length > 0
                ) {

                    socket.emit(
                        "purchaseError",

                        `Number(s) already sold: ${alreadySold.join(", ")}`
                    );

                    return;

                }

                // ------------------------------------------------
                // CALCULATE PRICE
                // ------------------------------------------------

                const total =
                    uniqueNumbers.length *
                    room.entryFee;

                                if ((room.id === "vip" || room.id === "superbingo") && currentBalance < total) {
                    socket.emit("purchaseError", `Insufficient balance. You need ${total} Birr.`);
                    return;
                }

                // Deduct the cartella price immediately. Every cartella selection
                // is a separate purchase, so each successful selection reduces the
                // player's available balance by room.entryFee.
                const newBalance = Math.max(0, currentBalance - total);
                setAccountBalance(socket.data.telegramUserId, socket.data.playerKey, newBalance);
                socket.data.balance = newBalance;
                socket.data.balanceAvailable = accountBeforePurchase.available;
                const roomPlayer = room.players.get(socket.id);
                if (roomPlayer) {
                    roomPlayer.balance = newBalance;
                    roomPlayer.balanceAvailable = true;
                }

const playerName =
                    socket.data.playerName ||
                    data?.playerName ||
                    "Player";

                // ------------------------------------------------
                // SAVE SOLD NUMBERS + GENERATE THE ACTUAL CARD
                // ------------------------------------------------

                const ownerKey = socket.data.playerKey || getPlayerKey({
                    telegramUserId: data?.telegramUserId,
                    username: data?.username,
                    name: playerName
                });

                if (room.id === "superbingo" && room.superbingoSelectionDeadlines && !room.superbingoSelectionDeadlines.has(ownerKey)) {
                    room.superbingoSelectionDeadlines.set(ownerKey, Date.now() + 30000);
                }

                // Every sold lottery/cartella number is already unique because
                // room.soldNumbers rejects numbers that another player owns.
                // In addition, every purchased Bingo card must be different.
                // We compare the complete 5x5 card signature and regenerate it
                // until it is unique within this round.
                const createUniqueCard = () => {
                    let card;
                    let signature;
                    let attempts = 0;
                    do {
                        card = generateCard();
                        signature = JSON.stringify(card);
                        attempts += 1;
                    } while (room.usedCardSignatures.has(signature) && attempts < 1000);

                    if (room.usedCardSignatures.has(signature)) {
                        throw new Error(`Could not generate a unique Bingo card for ${room.name}.`);
                    }

                    room.usedCardSignatures.add(signature);
                    return card;
                };

                uniqueNumbers.forEach(number => {
                    room.soldNumbers.set(number, {
                        socketId: socket.id,
                        ownerKey,
                        telegramUserId: socket.data.telegramUserId || null,
                        username: socket.data.username || null,
                        playerName
                    });

                    room.tickets.set(number, {
                        ticketNumber: number,
                        card: createUniqueCard(),
                        markedCells: new Set(),
                        confirmed: true,
                        socketId: socket.id,
                        ownerKey,
                        telegramUserId: socket.data.telegramUserId || null,
                        username: socket.data.username || null,
                        playerName,
                        purchasedAt: Date.now()
                    });
                });

                console.log(
                    `${playerName} bought numbers [${room.name}]:`,
                    uniqueNumbers
                );

                // Remember the account's active Bingo room so another device
                // using the same Telegram account opens this same playing room.
                setAccountActiveRoom(socket.data.telegramUserId, room.id);

                // ------------------------------------------------
                // PURCHASE SUCCESS
                // ------------------------------------------------

                socket.emit(
                    "purchaseSuccess",
                    {

                        success:
                            true,

                        roomId:
                            room.id,

                        numbers:
                            uniqueNumbers,

                        total:
                            total,

                        balance:
                            newBalance,

                        balanceAvailable:
                            accountBeforePurchase.available,

                        playerName:
                            playerName,

                        tickets: uniqueNumbers.map(number => room.tickets.get(number)),
                        myLuckySelectionEndsAt: room.id === "superbingo" ? (room.superbingoSelectionDeadlines.get(ownerKey) || null) : null

                    }
                );

                // ------------------------------------------------
                // UPDATE EVERY PLAYER
                // ------------------------------------------------

                io.to(room.id).emit(
                    "soldNumbersUpdated",
                    {

                        soldNumbers:
                            Array.from(
                                room.soldNumbers.keys()
                            ),

                        soldCount:
                            room.soldNumbers.size

                    }
                );

                broadcastRoomState(room);

                // Synchronize every open device belonging to this Telegram account.
                syncPlayerAccountRoom(room, ownerKey);

                // Start the 30-second buying window with the first purchase.
                // When it expires, the server starts the game and auto-draws.
                scheduleAutoStart(room.id);

            }
        );

        // ====================================================
        // CONFIRM / CANCEL PURCHASED CARTELLA
        // ====================================================

        socket.on("confirmTickets", () => {
            const room = getRoom(socket.data.roomId || DEFAULT_ROOM);
            if (!room) return socket.emit("ticketActionError", "Room not found.");
            if (room.gameStarted) return socket.emit("ticketActionError", "Ticket confirmation is closed because the game has started.");
            const own = Array.from(room.tickets.values()).filter(t => t.ownerKey === socket.data.playerKey);
            own.forEach(t => { t.confirmed = true; });
            socket.emit("ticketsConfirmed", {
                roomId: room.id,
                cards: own.map(t => ({ ticketNumber: t.ticketNumber, confirmed: true }))
            });
            socket.emit("myCards", {
                roomId: room.id,
                cards: own.map(t => ({ ticketNumber: t.ticketNumber, card: t.card, playerName: t.playerName, markedCells: Array.from(t.markedCells || []), confirmed: true })),
                gameStarted: room.gameStarted
            });
        });

        socket.on("cancelTicket", ({ ticketNumber } = {}) => {
            const room = getRoom(socket.data.roomId || DEFAULT_ROOM);
            const num = Number(ticketNumber);
            if (!room) return socket.emit("ticketActionError", "Room not found.");
            if (room.gameStarted) return socket.emit("ticketActionError", "Tickets cannot be cancelled after the game starts.");
            if (!Number.isInteger(num) || num < 1 || num > room.lotteryNumbers) return socket.emit("ticketActionError", "Invalid ticket number.");
            if (room.id === "superbingo") {
                const deadline = Number(room.superbingoSelectionDeadlines?.get(socket.data.playerKey) || 0);
                if (!deadline || Date.now() >= deadline) return socket.emit("ticketActionError", "The 30-second SuperBingo selection window is closed.");
            }
            const ticket = room.tickets.get(num);
            if (!ticket || ticket.ownerKey !== socket.data.playerKey) return socket.emit("ticketActionError", "You can only cancel your own ticket.");

            const account = getDepositedAccount(socket.data.telegramUserId, socket.data.playerKey, room.id);
            const refund = Number(room.entryFee || 0);
            const nextBalance = Number((account.balance + refund).toFixed(2));
            if (refund > 0) {
                setAccountBalance(socket.data.telegramUserId, socket.data.playerKey, nextBalance);
            }
            room.tickets.delete(num);
            room.soldNumbers.delete(num);
            room.usedCardSignatures.delete(JSON.stringify(ticket.card));
            socket.data.balance = nextBalance;
            const player = room.players.get(socket.id);
            if (player) player.balance = nextBalance;

            socket.emit("ticketCancelled", { roomId: room.id, ticketNumber: num, refund, balance: nextBalance, balanceAvailable: account.available });
            socket.emit("accountBalance", { available: account.available, balance: nextBalance });
            io.to(room.id).emit("soldNumbersUpdated", { soldNumbers: Array.from(room.soldNumbers.keys()), soldCount: room.soldNumbers.size });
            broadcastRoomState(room);
            syncPlayerAccountRoom(room, socket.data.playerKey);
        });

        // ====================================================
        // CHANGE LUCKY / CARTELLA NUMBER BEFORE GAME START
        // ====================================================

        socket.on("changeLuckyNumber", ({ oldNumber, newNumber } = {}) => {
            const room = getRoom(socket.data.roomId || DEFAULT_ROOM);
            const oldNum = Number(oldNumber);
            const newNum = Number(newNumber);

            if (!room) {
                socket.emit("changeError", "Room not found.");
                return;
            }
            if (room.gameStarted) {
                socket.emit("changeError", "Changing the lucky number is closed because the game has started.");
                return;
            }
            if (room.id === "superbingo") {
                const deadline = Number(room.superbingoSelectionDeadlines?.get(socket.data.playerKey) || 0);
                if (!deadline || Date.now() >= deadline) {
                    socket.emit("changeError", "The 30-second SuperBingo change window is closed.");
                    return;
                }
            }
            if (!Number.isInteger(oldNum) || !Number.isInteger(newNum) || oldNum < 1 || newNum < 1 || oldNum > room.lotteryNumbers || newNum > room.lotteryNumbers) {
                socket.emit("changeError", `Select a number from 1 to ${room.lotteryNumbers}.`);
                return;
            }
            if (oldNum === newNum) {
                socket.emit("changeError", "Choose a different available number.");
                return;
            }

            const ownerKey = socket.data.playerKey;
            syncTicketOwnershipToTelegramAccount(room, {
                playerKey: ownerKey,
                telegramUserId: socket.data.telegramUserId || null,
                username: socket.data.username || null
            });
            const oldTicket = room.tickets.get(oldNum);
            if (!oldTicket || oldTicket.ownerKey !== ownerKey) {
                socket.emit("changeError", "You can only change your own lucky number.");
                return;
            }
            if (room.soldNumbers.has(newNum)) {
                socket.emit("changeError", `Number ${newNum} is already sold.`);
                return;
            }

            // Generate the replacement Bingo card before changing room state.
            let newCard;
            let signature;
            let attempts = 0;
            do {
                newCard = generateCard();
                signature = JSON.stringify(newCard);
                attempts += 1;
            } while (room.usedCardSignatures.has(signature) && attempts < 1000);

            if (room.usedCardSignatures.has(signature)) {
                socket.emit("changeError", "Could not create a new Bingo card. Please try again.");
                return;
            }
            room.usedCardSignatures.add(signature);

            const playerName = oldTicket.playerName || socket.data.playerName || "Player";
            const ticket = {
                ticketNumber: newNum,
                card: newCard,
                markedCells: new Set(),
                confirmed: true,
                socketId: socket.id,
                ownerKey,
                telegramUserId: socket.data.telegramUserId || null,
                username: socket.data.username || null,
                playerName,
                purchasedAt: Date.now()
            };

            // This is a replacement, not a second purchase: the original
            // cartella payment remains valid, so the player's balance does not change.
            room.soldNumbers.delete(oldNum);
            room.tickets.delete(oldNum);
            room.soldNumbers.set(newNum, {
                socketId: socket.id,
                ownerKey,
                telegramUserId: socket.data.telegramUserId || null,
                username: socket.data.username || null,
                playerName
            });
            room.tickets.set(newNum, ticket);

            const account = getDepositedAccount(socket.data.telegramUserId, socket.data.playerKey, room.id);
            const currentBalance = account.available ? account.balance : 0;
            socket.data.balance = currentBalance;
            socket.data.balanceAvailable = account.available;

            socket.emit("changeSuccess", {
                success: true,
                roomId: room.id,
                oldNumber: oldNum,
                newNumber: newNum,
                balance: currentBalance,
                balanceAvailable: account.available,
                ticket
            });

            io.to(room.id).emit("soldNumbersUpdated", {
                soldNumbers: Array.from(room.soldNumbers.keys()),
                soldCount: room.soldNumbers.size
            });
            broadcastRoomState(room);
            syncPlayerAccountRoom(room, ownerKey);
        });

        // ====================================================
        // GET MY PURCHASED CARDS
        // ====================================================

        socket.on("getMyCards", () => {
            const room = getRoom(socket.data.roomId || DEFAULT_ROOM);
            if (!room) return;
            syncTicketOwnershipToTelegramAccount(room, {
                playerKey: socket.data.playerKey,
                telegramUserId: socket.data.telegramUserId || null,
                username: socket.data.username || null
            });
            const cards = Array.from(room.tickets.values())
                .filter(t => t.ownerKey === socket.data.playerKey)
                .map(t => ({
                    ticketNumber: t.ticketNumber,
                    card: t.card,
                    playerName: t.playerName,
                    markedCells: Array.from(t.markedCells || [])
                }));
            socket.emit("myCards", { roomId: room.id, cards, gameStarted: room.gameStarted });
        });

        // ====================================================
        // MARK / UNMARK A CALLED NUMBER ON THE PLAYER'S CARD
        // ====================================================

        socket.on("markCardCell", ({ ticketNumber, row, col, selected } = {}) => {
            const room = getRoom(socket.data.roomId || DEFAULT_ROOM);
            const ticket = room && room.tickets.get(Number(ticketNumber));
            const r = Number(row);
            const c = Number(col);

            if (!room || !ticket || ticket.ownerKey !== socket.data.playerKey) {
                socket.emit("markResult", { success: false, message: "Card not found." });
                return;
            }
            if (!room.gameStarted) {
                socket.emit("markResult", { success: false, message: "The game is not in progress." });
                return;
            }
            if (!Number.isInteger(r) || !Number.isInteger(c) || r < 0 || r > 4 || c < 0 || c > 4) {
                socket.emit("markResult", { success: false, message: "Invalid card position." });
                return;
            }

            const value = ticket.card[r][c];
            const cellKey = `${r}:${c}`;

            if (value === "FREE") {
                ticket.markedCells.add(cellKey);
                socket.emit("markResult", { success: true, ticketNumber: ticket.ticketNumber, row: r, col: c, selected: true });
                return;
            }

            if (!room.calledNumbers.includes(Number(value))) {
                socket.emit("markResult", { success: false, message: "You can only select a number after it is drawn." });
                return;
            }

            if (selected === false) ticket.markedCells.delete(cellKey);
            else ticket.markedCells.add(cellKey);

            socket.emit("markResult", {
                success: true,
                ticketNumber: ticket.ticketNumber,
                row: r,
                col: c,
                selected: ticket.markedCells.has(cellKey)
            });

            // Keep the same account's other devices on the same card/mark state.
            syncPlayerAccountRoom(room, socket.data.playerKey);
        });

        // ====================================================
        // BINGO CLAIM (server-side validation of PLAYER MARKS)
        // ====================================================

        socket.on("claimBingo", ({ ticketNumber } = {}) => {
            const room = getRoom(socket.data.roomId || DEFAULT_ROOM);
            const ticket = room && room.tickets.get(Number(ticketNumber));
            if (!room || !ticket || ticket.ownerKey !== socket.data.playerKey) {
                socket.emit("bingoResult", { success: false, message: "Card not found." });
                return;
            }
            if (!room.gameStarted) {
                socket.emit("bingoResult", { success: false, message: "The game is not in progress." });
                return;
            }

            // Bingo must be claimed after the player completes a line and
            // before the server calls the next number.
            if (!room.bingoClaimOpenUntil || Date.now() > room.bingoClaimOpenUntil) {
                socket.emit("bingoResult", {
                    success: false,
                    message: "Too late for this draw. Select the called numbers and press BINGO before the next number is called."
                });
                return;
            }

            // FREE is always treated as selected for a valid Bingo pattern.
            const isMarked = (r, c) => {
                const value = ticket.card[r][c];
                return value === "FREE" || ticket.markedCells.has(`${r}:${c}`);
            };

            // Every marked cell must correspond to a number that was actually drawn.
            for (const cellKey of ticket.markedCells) {
                const [r, c] = cellKey.split(":").map(Number);
                const value = ticket.card[r][c];
                if (value !== "FREE" && !room.calledNumbers.includes(Number(value))) {
                    ticket.markedCells.delete(cellKey);
                }
            }

            // SuperBingo has a different winning rule: the player wins only
            // after the ENTIRE 5x5 cartella is marked (FREE/star counts as
            // already marked). This means every horizontal, vertical and
            // diagonal line is complete before a win can be verified.
            let win = false;
            let winningPattern = null;

            if (room.id === "superbingo") {
                const allCells = [];
                for (let r = 0; r < 5; r++) {
                    for (let c = 0; c < 5; c++) {
                        allCells.push([r, c]);
                    }
                }
                win = allCells.every(([r, c]) => isMarked(r, c));
                if (win) {
                    winningPattern = {
                        type: "full-card",
                        index: null,
                        cells: allCells
                    };
                }
            } else {
                for (let r = 0; r < 5; r++) {
                    if ([0,1,2,3,4].every(c => isMarked(r, c))) {
                        win = true;
                        winningPattern = { type: "row", index: r, cells: [0,1,2,3,4].map(c => [r,c]) };
                        break;
                    }
                }
                if (!win) {
                    for (let c = 0; c < 5; c++) {
                        if ([0,1,2,3,4].every(r => isMarked(r, c))) {
                            win = true;
                            winningPattern = { type: "column", index: c, cells: [0,1,2,3,4].map(r => [r,c]) };
                            break;
                        }
                    }
                }
                if (!win && [0,1,2,3,4].every(i => isMarked(i, i))) {
                    win = true;
                    winningPattern = { type: "diagonal", index: 0, cells: [0,1,2,3,4].map(i => [i,i]) };
                }
                if (!win && [0,1,2,3,4].every(i => isMarked(i, 4 - i))) {
                    win = true;
                    winningPattern = { type: "diagonal", index: 1, cells: [0,1,2,3,4].map(i => [i,4-i]) };
                }
            }

            socket.emit("bingoResult", {
                success: !!win,
                ticketNumber: Number(ticketNumber),
                message: win
                    ? (room.id === "superbingo"
                        ? "SUPERBINGO! All lines on your cartella are complete."
                        : "BINGO! Your selected numbers form a valid horizontal, vertical, or diagonal line.")
                    : (room.id === "superbingo"
                        ? "Not a SuperBingo yet. Mark every number on your cartella so all lines are complete."
                        : "Not a Bingo yet. Select the drawn numbers on your card and complete a horizontal, vertical, or diagonal line.")
            });

            if (win) {
                // Finish this round, announce the winner to every player,
                // then open the next round after a synchronized countdown.
                // Keep the completed round visible during the announcement.
                if (room.roundTransition) return;
                room.roundTransition = true;
                room.gameStarted = false;
                stopAutoDraw(room.id);
                stopAutoStart(room.id);

                // Pay the verified winner from the current round's prize pool.
                // The prize pool is the same 80% amount shown as DERASH in the room.
                const totalSales = room.soldNumbers.size * room.entryFee;
                const winnerPrize = Number((totalSales * WINNER_PAYOUT_PERCENT / 100).toFixed(2));
                const balanceKey = getBalanceKey(
                    socket.data.telegramUserId,
                    socket.data.playerKey,
                    room.id
                );
                const balanceBeforeWin = getDepositedAccount(
                    socket.data.telegramUserId,
                    socket.data.playerKey,
                    room.id
                ).balance;
                const balanceAfterWin = Number((balanceBeforeWin + winnerPrize).toFixed(2));

                if (balanceKey) {
                    setAccountBalance(socket.data.telegramUserId, socket.data.playerKey, balanceAfterWin);
                }

                socket.data.balance = balanceAfterWin;
                const winnerPlayer = room.players.get(socket.id);
                if (winnerPlayer) winnerPlayer.balance = balanceAfterWin;

                // Send the new balance privately to the winner.
                socket.emit("accountBalance", {
                    available: true,
                    balance: balanceAfterWin,
                    prize: winnerPrize
                });

                const winnerPayload = {
                    success: true,
                    roomId: room.id,
                    roomName: room.name,
                    playerName: ticket.playerName,
                    ticketNumber: Number(ticketNumber),
                    prize: winnerPrize,
                    totalPrizePool: winnerPrize,
                    balance: balanceAfterWin,
                    winningPattern,
                    winningRow: winningPattern?.type === "row" ? winningPattern.index : null,
                    winningCard: ticket.card,
                    message: "BINGO WINNER VERIFIED"
                };

                // Winner notification is sent separately into every player's
                // private playing room, never as a public playing-room event.
                const nextRoundAt = Date.now() + WINNER_DISPLAY_MS;
                winnerPayload.nextRoundAt = nextRoundAt;
                winnerPayload.serverNow = Date.now();
                winnerPayload.nextRoundSeconds = Math.ceil(WINNER_DISPLAY_MS / 1000);
                emitToPrivatePlayerRooms(room, "winner", winnerPayload);

                // Keep the winner screen visible for the same server-authoritative
                // countdown on every device. Only after it reaches zero do we
                // clear the completed round and open the next buying/selection room.
                broadcastRoomState(room);
                setTimeout(() => {
                    const current = getRoom(room.id);
                    if (!current || !current.roundTransition) return;

                    resetRoom(current);
                    current.roundTransition = false;
                    scheduleAutoStart(current.id);

                    if (current.id === "superbingo") {
                        emitToPrivatePlayerRooms(current, "returnToSelectionRoom", () =>
                            getPrivateRoomState(current, socket.data.playerKey)
                        );
                    } else {
                        emitToPrivatePlayerRooms(current, "nextRound", () => ({
                            success: true,
                            roomId: current.id,
                            roomName: current.name,
                            message: `NEW ${current.name.toUpperCase()} ROUND OPEN`,
                            buyingEndsAt: current.buyingEndsAt
                        }));
                    }

                    broadcastRoomState(current);
                }, WINNER_DISPLAY_MS);
            }
        });

        // ====================================================
        // DISCONNECT
        // ====================================================

        socket.on(
            "disconnect",
            () => {

                const roomId =
                    socket.data.roomId;

                const room =
                    getRoom(roomId);

                if (room) {

                    const player =
                        room.players.get(
                            socket.id
                        );

                    if (player) {

                        console.log(
                            `${player.name} disconnected from ${room.name}`
                        );

                    }

                    room.players.delete(
                        socket.id
                    );

                    broadcastRoomState(room);

                }

                console.log(
                    "Player disconnected:",
                    socket.id
                );

            }
        );

    }
);

// ============================================================
// TELEGRAM API
// ============================================================

async function telegramRequest(
    method,
    data = {}
) {

    if (!TELEGRAM_BOT_TOKEN) {

        throw new Error(
            "TELEGRAM_BOT_TOKEN is missing."
        );

    }

    const url =
        `https://api.telegram.org/bot${TELEGRAM_BOT_TOKEN}/${method}`;

    const response =
        await fetch(
            url,
            {

                method: "POST",

                headers: {

                    "Content-Type":
                        "application/json"

                },

                body:
                    JSON.stringify(data)

            }
        );

    const result =
        await response.json();

    if (!result.ok) {

        throw new Error(
            result.description ||
            "Telegram API error"
        );

    }

    return result.result;

}

// ============================================================
// SEND TELEGRAM MESSAGE
// ============================================================

async function sendTelegramMessage(
    chatId,
    text,
    replyMarkup = undefined
) {

    try {

        const data = {

            chat_id:
                chatId,

            text:
                text

        };

        if (replyMarkup) {

            data.reply_markup =
                replyMarkup;

        }

        await telegramRequest(
            "sendMessage",
            data
        );

        console.log(
            "Telegram message sent to:",
            chatId
        );

    } catch (error) {

        console.error(
            "Telegram send error:",
            error.message
        );

    }

}

// ============================================================
// TELEGRAM REGISTRATION
// ============================================================

function isTelegramUserRegistered(chatId) {

    const telegramId = String(chatId);

    const user = db.prepare(`
        SELECT id, phone_number
        FROM users
        WHERE telegram_id = ?
        LIMIT 1
    `).get(telegramId);

    return Boolean(
        user &&
        user.phone_number &&
        String(user.phone_number).trim().length > 0
    );

}

async function sendRegistrationPrompt(chatId) {

    await sendTelegramMessage(
        chatId,
        `🛡️ ምዝገባ ያስፈልጋል (Registration Required)\n\n` +
        `EdilBingoን ለመጠቀም ከታች Share Phone የሚለውን ይጫኑት። ከዛም Share የሚለውን ይጫኑ።`,
        {
            keyboard: [
                [
                    {
                        text: "📱 Share Phone",
                        request_contact: true
                    }
                ]
            ],
            resize_keyboard: true,
            one_time_keyboard: true,
            input_field_placeholder: "Share your phone number"
        }
    );

}

// ============================================================
// TELEGRAM /START
// ============================================================

async function handleTelegramStart(
    chatId
) {

    console.log(
        "Telegram /start received."
    );

    // New players must register first by sharing their own phone number.
    // Registered players continue directly to the game-room menu.
    if (!isTelegramUserRegistered(chatId)) {

        await sendRegistrationPrompt(chatId);
        return;

    }

    if (!MINI_APP_URL) {

        await sendTelegramMessage(

            chatId,

`🎱 EDILBINGO

Choose a room to join the game.

⚠️ MINI_APP_URL is not configured.`

        );

        return;

    }

    const baseUrl =
        MINI_APP_URL.replace(
            /\/+$/,
            ""
        );

    // ========================================================
    // TELEGRAM ROOM BUTTONS
    // ========================================================

    const keyboard = {

        inline_keyboard: [

            [
                {

                    text:
                        "🎰 PLAY — 10 ETB",

                    web_app: {

                        url:
                            `${baseUrl}/vip-room.html?room=vip`

                    }

                }

            ],

            [
                {

                    text:
                        "🏆 SuperBingo — 50 ETB",

                    web_app: {

                        url:
                            `${baseUrl}/superbingo-selection-room.html`

                    }

                }

            ],

            [
                {

                    text:
                        "⚽ EdilBingo Bonus — FREE",

                    web_app: {

                        url:
                            `${baseUrl}/goodbingo-room.html`

                    }

                }

            ],



        ]

    };

    // ========================================================
    // MESSAGE
    // ========================================================

    const message =

`🎱 EDILBINGO

Choose a room to join the game:

🎰 PLAY — 10 ETB
🏆 SuperBingo — 50 ETB
⚽ EdilBingo Bonus — FREE`;

    console.log(
        "Mini App keyboard created."
    );

    console.log(
        "PLAY URL (VIP room):",
        `${baseUrl}/vip-room.html?room=vip`
    );

    await sendTelegramMessage(
        chatId,
        message,
        keyboard
    );

}

// ============================================================
// TELEGRAM ROOM COMMAND HELPER
// ============================================================

function getTelegramRoomId(text) {

    const parts =
        text.trim().split(/\s+/);

    let requestedRoom =
        parts[1]
            ? parts[1].toLowerCase()
            : DEFAULT_ROOM;

    if (requestedRoom === "play") requestedRoom = "vip";

    if (
        rooms[requestedRoom]
    ) {

        return requestedRoom;

    }

    return DEFAULT_ROOM;

}

// ============================================================
// TELEGRAM /NEWGAME
// ============================================================

async function handleTelegramNewGame(
    chatId,
    roomId = DEFAULT_ROOM
) {

    const room =
        getRoom(roomId);

    if (!room) {

        await sendTelegramMessage(
            chatId,
            "⚠️ Room not found."
        );

        return;

    }

    resetRoom(room);
    scheduleAutoStart(room.id);

    console.log(
        `NEW GAME FROM TELEGRAM [${room.name}]`
    );

    io.to(room.id).emit(
        "newGameStarted",
        getRoomState(room)
    );

    broadcastRoomState(room);

    await sendTelegramMessage(

        chatId,

`🎱 EDILBINGO

🟢 NEW GAME STARTED!

Room: ${room.name}

Entry: ${room.entryFee} ETB

All 75 numbers are available.

Use:

/draw ${room.id}

to draw the first number.`

    );

}

// ============================================================
// TELEGRAM /DRAW
// ============================================================

async function handleTelegramDraw(
    chatId,
    roomId = DEFAULT_ROOM
) {

    const result =
        performDraw(roomId);

    if (!result.success) {

        await sendTelegramMessage(

            chatId,

            `⚠️ ${result.message}`

        );

        return;

    }

    await sendTelegramMessage(

        chatId,

`🎱 EDILBINGO

🔔 NUMBER DRAWN

━━━━━━━━━━━━━━
ROOM: ${result.roomId}
━━━━━━━━━━━━━━

${result.display}

━━━━━━━━━━━━━━

📊 Called:
${result.totalCalled} / 75

🔢 Remaining:
${result.remaining}

Good luck! 🍀`

    );

}

// ============================================================
// TELEGRAM /STATUS
// ============================================================

async function handleTelegramStatus(
    chatId,
    roomId = DEFAULT_ROOM
) {

    const room =
        getRoom(roomId);

    if (!room) {

        await sendTelegramMessage(
            chatId,
            "⚠️ Room not found."
        );

        return;

    }

    let numbersText;

    if (
        room.calledNumbers.length === 0
    ) {

        numbersText =
            "None";

    } else {

        numbersText =
            room.calledNumbers
                .map(
                    number =>
                        `${getLetter(number)}-${number}`
                )
                .join(", ");

    }

    await sendTelegramMessage(

        chatId,

`🎱 EDILBINGO STATUS

🏠 Room:
${room.name}

💰 Entry:
${room.entryFee} ETB

Game:
${room.gameStarted
    ? "🟢 RUNNING"
    : "🔴 STOPPED"}

📊 Called:
${room.calledNumbers.length} / 75

🔢 Remaining:
${75 - room.calledNumbers.length}

👥 Players:
${room.players.size}

🎟 Sold:
${room.soldNumbers.size}

📋 Numbers:
${numbersText}`

    );

}

// ============================================================
// TELEGRAM /STOP
// ============================================================

async function handleTelegramStop(
    chatId,
    roomId = DEFAULT_ROOM
) {

    const room =
        getRoom(roomId);

    if (!room) {

        await sendTelegramMessage(
            chatId,
            "⚠️ Room not found."
        );

        return;

    }

    room.gameStarted = false;

    console.log(
        `GAME STOPPED FROM TELEGRAM [${room.name}]`
    );

    io.to(room.id).emit(
        "gameStopped",
        getRoomState(room)
    );

    broadcastRoomState(room);

    await sendTelegramMessage(

        chatId,

`🎱 EDILBINGO

🔴 GAME STOPPED

Room:
${room.name}

Use:

/newgame ${room.id}

to start a new game.`

    );

}

// ============================================================
// DEPOSIT REQUEST HELPERS
// ============================================================

function extractDepositAmountFromSms(smsText) {
    const candidates = String(smsText || "").match(
        /(?:ETB|Birr|ብር|amount|paid|received|deposit)[^0-9]{0,20}([0-9]{1,3}(?:[, ]?[0-9]{3})*(?:\.\d{1,2})?)/ig
    ) || [];
    const values = candidates.map(x => {
        const m = x.match(/([0-9]{1,3}(?:[, ]?[0-9]{3})*(?:\.\d{1,2})?)\s*$/);
        return m ? Number(m[1].replace(/[, ]/g, "")) : NaN;
    }).filter(Number.isFinite);
    return values.length ? Number(values[0].toFixed(2)) : NaN;
}

function extractPhoneFromSms(smsText) {
    const match = String(smsText || "").match(
        /(?:09\d{8}|07\d{8}|\+251\s*9\d{8}|\+251\s*7\d{8})/
    );
    return match ? match[0].replace(/\s+/g, "") : null;
}

async function notifyPendingDepositCreated(requestId, user, method, requestedAmount, detectedAmount) {
    await sendTelegramMessage(
        user.telegram_id,
        `የተከበሩ የእድልBinጎ ደንበኛችን\n\n` +
        `የከፈሉት የብር መጠን እየተመረመረ ነው፣እባክዎ በትዕግስት ይጠብቁ፡፡\n` +
        `የጠየቁት መጠን: ${requestedAmount.toFixed(2)} ETB\n\n` +
        `እናመሰግናለን፡፡`
    );

    if (ADMIN_TELEGRAM_ID) {
        await sendTelegramMessage(
            ADMIN_TELEGRAM_ID,
            `🔎 NEW DEPOSIT FOR VERIFICATION\n\n` +
            `🆔 Request: #${requestId}\n` +
            `👤 ${user.first_name || user.username || "Customer"}\n` +
            `📱 Phone: ${user.phone_number || "—"}\n` +
            `🆔 Telegram ID: ${user.telegram_id}\n` +
            `💳 Method: ${method}\n` +
            `💰 Requested: ${requestedAmount.toFixed(2)} ETB\n` +
            `📨 SMS amount: ${Number.isFinite(detectedAmount) ? detectedAmount.toFixed(2) : "NOT FOUND"} ETB\n\n` +
            `Verify the SMS before approving.`,
            {
                inline_keyboard: [[
                    { text: `✅ Approve #${requestId}`, callback_data: `deposit_approve_${requestId}` },
                    { text: `❌ Reject #${requestId}`, callback_data: `deposit_reject_${requestId}` }
                ]]
            }
        );
    }
}

async function approveDepositRequest(requestId, adminTelegramId) {
    const request = db.prepare(`
        SELECT dr.*, u.first_name, u.username, u.phone_number, u.balance
        FROM deposit_requests dr JOIN users u ON u.id = dr.user_id
        WHERE dr.id = ? LIMIT 1
    `).get(requestId);

    if (!request) throw new Error("Deposit request was not found.");
    if (request.status !== "pending") throw new Error(`Deposit request #${requestId} is already ${request.status}.`);

    const requested = Number(request.requested_amount);
    const detected = Number(request.detected_amount);
    if (!Number.isFinite(detected) || Math.abs(detected - requested) > 0.001) {
        throw new Error(`Amount mismatch: requested ${requested.toFixed(2)} ETB, SMS shows ${Number.isFinite(detected) ? detected.toFixed(2) : "unknown"} ETB.`);
    }

    const reference = `deposit_request:${requestId}`;
    if (db.prepare(`SELECT id FROM transactions WHERE reference = ? LIMIT 1`).get(reference)) {
        throw new Error("This deposit has already been credited.");
    }

    const newBalance = db.transaction(() => {
        const current = db.prepare(`SELECT balance FROM users WHERE id = ?`).get(request.user_id);
        const updated = Number((Number(current?.balance || 0) + requested).toFixed(2));

        db.prepare(`UPDATE users SET balance = ? WHERE id = ?`).run(updated, request.user_id);
        db.prepare(`
            INSERT INTO transactions (user_id, type, amount, reference, status, description)
            VALUES (?, 'deposit', ?, ?, 'completed', ?)
        `).run(request.user_id, requested, reference, `Verified ${request.method} deposit request #${requestId}`);

        db.prepare(`
            UPDATE deposit_requests SET status='approved', admin_id=?, processed_at=CURRENT_TIMESTAMP WHERE id=?
        `).run(String(adminTelegramId), requestId);

        return updated;
    })();

    setAccountBalance(request.telegram_id, `tg:${request.telegram_id}`, newBalance);

    await sendTelegramMessage(
        request.telegram_id,
        `✅ Deposit ተረጋግጧል።\n\n`
        `💰 Added: ${requested.toFixed(2)} ETB\n` +
        `💵 New balance: ${newBalance.toFixed(2)} ETB\n\n` +
        `እናመሰግናለን።`
    );
    return { request, newBalance };
}

async function rejectDepositRequest(requestId, adminTelegramId) {
    const request = db.prepare(`
        SELECT dr.* FROM deposit_requests dr WHERE dr.id = ? LIMIT 1
    `).get(requestId);

    if (!request) throw new Error("Deposit request was not found.");
    if (request.status !== "pending") throw new Error(`Deposit request #${requestId} is already ${request.status}.`);

    db.prepare(`
        UPDATE deposit_requests SET status='rejected', admin_id=?, processed_at=CURRENT_TIMESTAMP WHERE id=?
    `).run(String(adminTelegramId), requestId);

    await sendTelegramMessage(
        request.telegram_id,
        `❌ Deposit ማረጋገጫው አልተሳካም።\n\n` +
        `የተላከው የክፍያ መረጃ በምርመራ ላይ የተጠየቀውን መጠን አላረጋገጠም።`
    );
    return request;
}

// ============================================================
// PROCESS TELEGRAM MESSAGE
// ============================================================

async function processTelegramMessage(
    message
) {

    if (
        !message ||
        !message.chat
    ) {

        return;

    }

    const chatId =
        message.chat.id;

    // ========================================================
    // TELEGRAM CONTACT / PHONE REGISTRATION
    // ========================================================
    if (message.contact) {

        const contact = message.contact;
        const telegramId = String(message.from?.id || contact.user_id || chatId);

        // Accept only the phone number shared by the Telegram user
        // themselves, not somebody else's contact.
        if (contact.user_id && String(contact.user_id) !== telegramId) {
            await sendTelegramMessage(
                chatId,
                "❌ Please use the Share Phone button to share your own phone number."
            );
            return;
        }

        try {
            const existingUser = db.prepare(
                `SELECT id FROM users WHERE telegram_id = ?`
            ).get(telegramId);

            if (existingUser) {
                db.prepare(
                    `UPDATE users SET phone_number = ?, username = ?, first_name = ? WHERE telegram_id = ?`
                ).run(
                    contact.phone_number,
                    message.from?.username || null,
                    message.from?.first_name || null,
                    telegramId
                );
            } else {
                // NEW PLAYER REGISTRATION BONUS
                // Give every newly registered player a one-time free 100 ETB
                // starting deposit. The bonus is stored in the user's real
                // account balance and recorded as a completed transaction so
                // the balance/history can use the same server-side source.
                const registrationBonus = 100;

                const createNewUser = db.transaction(() => {
                    const result = db.prepare(
                        `INSERT INTO users (telegram_id, username, first_name, phone_number, balance)
                         VALUES (?, ?, ?, ?, ?)`
                    ).run(
                        telegramId,
                        message.from?.username || null,
                        message.from?.first_name || null,
                        contact.phone_number,
                        registrationBonus
                    );

                    db.prepare(
                        `INSERT INTO transactions
                         (user_id, type, amount, reference, status, description)
                         VALUES (?, ?, ?, ?, ?, ?)`
                    ).run(
                        result.lastInsertRowid,
                        "registration_bonus",
                        registrationBonus,
                        `registration_bonus:${telegramId}`,
                        "completed",
                        "Free 100 ETB registration deposit bonus"
                    );
                });

                createNewUser();
            }

            // Remove the Share Phone keyboard, then show the normal game menu.
            await sendTelegramMessage(
                chatId,
                "✅ Registration completed successfully!\n\nYour phone number has been registered with EdilBingo.",
                {
                    remove_keyboard: true
                }
            );

            await handleTelegramStart(chatId);

        } catch (error) {
            console.error(
                "Telegram registration error:",
                error.message
            );

            await sendTelegramMessage(
                chatId,
                "❌ Registration could not be completed. Please try again."
            );
        }

        return;
    }

    const text =
        (
            message.text ||
            ""
        ).trim();

    if (!text) {
        return;
    }

    console.log(
        `Telegram message from ${chatId}: ${text}`
    );

    const depositInput = pendingDepositInputs.get(String(message.from?.id || chatId));
    if (depositInput && !text.startsWith('/')) {
        const telegramId = String(message.from?.id || chatId);

        if (depositInput.step === "amount") {
            const requestedAmount = Number(text.replace(/[, ]/g, ""));
            if (!Number.isFinite(requestedAmount) || requestedAmount <= 0) {
                await sendTelegramMessage(chatId, "❌ የተሳሳተ የብር መጠን። ለምሳሌ: 100");
                return;
            }
            depositInput.step = "sms";
            depositInput.requestedAmount = Number(requestedAmount.toFixed(2));
            pendingDepositInputs.set(telegramId, depositInput);

            await sendTelegramMessage(
                chatId,
                `💰 የተጠየቀው Deposit: ${depositInput.requestedAmount.toFixed(2)} ETB\n\n` +
                `አሁን የ${depositInput.method} የክፍያ SMS ቅጂውን እዚህ ይላኩ።`
            );
            return;
        }

        if (depositInput.step === "sms") {
            const requestedAmount = Number(depositInput.requestedAmount);
            const detectedAmount = extractDepositAmountFromSms(text);
            const detectedPhone = extractPhoneFromSms(text);
            const user = db.prepare(`
                SELECT id, telegram_id, first_name, username, phone_number, balance
                FROM users WHERE telegram_id = ? LIMIT 1
            `).get(telegramId);

            pendingDepositInputs.delete(telegramId);

            if (!user) {
                await sendTelegramMessage(chatId, "❌ እባክዎ መጀመሪያ ይመዝገቡ።");
                return;
            }
            if (!Number.isFinite(detectedAmount)) {
                await sendTelegramMessage(chatId, "❌ በSMS ውስጥ የክፍያውን መጠን ማግኘት አልተቻለም።");
                return;
            }
            if (Math.abs(detectedAmount - requestedAmount) > 0.001) {
                await sendTelegramMessage(
                    chatId,
                    `❌ የብር መጠን አልተመሳሰለም።\n\n` +
                    `የጠየቁት: ${requestedAmount.toFixed(2)} ETB\n` +
                    `በSMS የታየው: ${detectedAmount.toFixed(2)} ETB\n\n` +
                    `እባክዎ ትክክለኛውን Deposit እንደገና ይጠይቁ።`
                );
                return;
            }

            const duplicate = db.prepare(`SELECT id, status FROM deposit_requests WHERE sms_text = ? LIMIT 1`).get(text);
            if (duplicate) {
                await sendTelegramMessage(chatId, `❌ ይህ SMS ከዚህ በፊት ተልኳል። Request #${duplicate.id} (${duplicate.status}).`);
                return;
            }

            const result = db.prepare(`
                INSERT INTO deposit_requests
                    (user_id, telegram_id, method, requested_amount, sms_text, detected_amount, detected_phone, status)
                VALUES (?, ?, ?, ?, ?, ?, ?, 'pending')
            `).run(
                user.id, telegramId, depositInput.method, requestedAmount,
                text, detectedAmount, detectedPhone
            );

            await notifyPendingDepositCreated(
                Number(result.lastInsertRowid), user, depositInput.method,
                requestedAmount, detectedAmount
            );
            return;
        }
    }

    // Admin-only phone lookup: after /searchphone, accept a plain phone
    // number and return the Telegram ID saved for that registered account.
    const senderTelegramId = String(message.from?.id || chatId);
    if (isTelegramAdmin(senderTelegramId) && pendingAdminPhoneSearch.has(senderTelegramId) && !text.startsWith('/')) {
        const phoneCandidate = normalizeEthiopianPhone(text);
        if (!/^0[79]\d{8}$/.test(phoneCandidate)) {
            await sendTelegramMessage(
                chatId,
                '❌ Invalid Ethiopian phone number.\n\nExample: +251910970993'
            );
            return;
        }

        pendingAdminPhoneSearch.delete(senderTelegramId);
        const user = findUserByPhone(phoneCandidate);
        if (!user) {
            await sendTelegramMessage(
                chatId,
                `❌ No registered account was found for ${formatPhoneForDisplay(phoneCandidate)}.`
            );
            return;
        }

        await sendTelegramMessage(
            chatId,
            `✅ Customer found!\n\n` +
            `📱 Phone: ${formatPhoneForDisplay(user.phone_number || phoneCandidate)}\n` +
            `🆔 Telegram ID: ${user.telegram_id}\n` +
            `👤 Name: ${user.first_name || '—'}\n` +
            `👤 Username: ${user.username ? '@' + user.username : '—'}\n` +
            `💰 Balance: ${Number(user.balance || 0).toFixed(2)} ETB`
        );
        return;
    }

    const command =
        text
            .split(/\s+/)[0]
            .split("@")[0]
            .toLowerCase();

    const roomId =
        getTelegramRoomId(text);

    try {

        switch (command) {

            // ================================================
            // PLAYER MENU COMMANDS
            // ================================================

            case "/myid": {

                const telegramId = String(
                    message.from?.id || chatId
                );

                await sendTelegramMessage(
                    chatId,
                    `🆔 Your Telegram ID is:\n\n${telegramId}\n\n` +
                    `Send this number to the bot owner/admin to configure your account as an administrator.`
                );

                break;
            }

            case "/admin": {

                const telegramId = String(
                    message.from?.id || chatId
                );

                if (!isTelegramAdmin(telegramId)) {
                    await sendTelegramMessage(
                        chatId,
                        "❌ You are not authorized as an EdilBingo administrator."
                    );
                    break;
                }

                await sendTelegramMessage(
                    chatId,
                    `🛡️ EDILBINGO ADMIN\n\n` +
                    `Telegram ID: ${telegramId}\n` +
                    `Status: ✅ Administrator`
                );

                break;
            }

            case "/home": {

                const telegramId = String(message.from?.id || chatId);

                // Keep every Telegram command in the Menu. /home simply opens
                // the screenshot-matched Home Mini App; it does not replace or
                // remove the other commands.
                if (!isTelegramAdmin(telegramId)) {
                    await handleTelegramStart(chatId);
                    break;
                }

                const baseUrl = MINI_APP_URL ? MINI_APP_URL.replace(/\/+$/, "") : "";
                if (!baseUrl) {
                    await sendTelegramMessage(chatId, "⚠️ Home Mini App is not configured. Set MINI_APP_URL first.");
                    break;
                }

                await sendTelegramMessage(
                    chatId,
                    "🏠 እድልBINGO Home\n\nAdmin menu and Home panel:",
                    {
                        inline_keyboard: [
                            [
                                {
                                    text: "🏠 Open Home",
                                    web_app: { url: `${baseUrl}/telegram-home.html` }
                                }
                            ],
                            [
                                {
                                    text: "🔎 Search By Phone Number",
                                    callback_data: "admin_search_phone"
                                }
                            ],
                            [
                                {
                                    text: "💰 Add Balance",
                                    callback_data: "admin_add_balance"
                                }
                            ]
                        ]
                    }
                );
                break;
            }

            case "/searchphone": {

                const telegramId = String(message.from?.id || chatId);
                if (!isTelegramAdmin(telegramId)) {
                    await sendTelegramMessage(chatId, "❌ Admin access required.");
                    break;
                }

                pendingAdminPhoneSearch.add(telegramId);
                await sendTelegramMessage(
                    chatId,
                    "🔎 Search By Phone Number\n\nPlease send the customer phone number, for example:\n+251910970993\n\nThe registered customer's Telegram ID will be shown."
                );
                break;
            }

            case "/addbalance": {

                const telegramId = String(message.from?.id || chatId);
                if (!isTelegramAdmin(telegramId)) {
                    await sendTelegramMessage(chatId, "❌ Admin access required.");
                    break;
                }

                const args = text.split(/\s+/).slice(1);
                const targetTelegramId = String(args[0] || "").trim();
                const amount = Number(args[1]);

                if (!targetTelegramId || !Number.isFinite(amount) || amount <= 0) {
                    await sendTelegramMessage(
                        chatId,
                        "💰 Add Balance\n\nUsage:\n/addbalance TELEGRAM_ID AMOUNT\n\nExample:\n/addbalance 456801294 400"
                    );
                    break;
                }

                const user = db.prepare(
                    `SELECT id, first_name, username, balance FROM users WHERE telegram_id = ? LIMIT 1`
                ).get(targetTelegramId);

                if (!user) {
                    await sendTelegramMessage(chatId, `❌ User ${targetTelegramId} was not found.`);
                    break;
                }

                const addAmount = Number(amount.toFixed(2));
                const newBalance = Number((Number(user.balance || 0) + addAmount).toFixed(2));
                db.transaction(() => {
                    db.prepare("UPDATE users SET balance = ? WHERE id = ?").run(newBalance, user.id);
                    db.prepare(`
                        INSERT INTO transactions (user_id, type, amount, reference, status, description)
                        VALUES (?, 'deposit', ?, ?, 'completed', ?)
                    `).run(user.id, addAmount, `admin_manual:${telegramId}:${Date.now()}`, `Admin manual balance add by ${telegramId}`);
                })();
                setAccountBalance(targetTelegramId, `tg:${targetTelegramId}`, newBalance);

                // Notify the customer immediately after the balance is successfully
                // increased by an administrator. A notification failure must not
                // undo or hide the successful balance update.
                try {
                    await sendTelegramMessage(
                        user.telegram_id || targetTelegramId,
                        `🔔 Balance Update\n\n` +
                        `✅ Your EdilBingo balance has been increased.\n\n` +
                        `💰 Added: ${addAmount.toFixed(2)} ETB\n` +
                        `💵 New balance: ${newBalance.toFixed(2)} ETB\n\n` +
                        `Thank you for using EdilBingo!`
                    );
                } catch (notificationError) {
                    console.error(
                        "Balance update notification failed:",
                        notificationError.message
                    );
                }

                await sendTelegramMessage(
                    chatId,
                    `✅ Balance added successfully!\n\n` +
                    `👤 Telegram ID: ${targetTelegramId}\n` +
                    `💰 Added: ${addAmount.toFixed(2)} ETB\n` +
                    `💵 New balance: ${newBalance.toFixed(2)} ETB\n` +
                    `🔔 Customer notification: sent`
                );
                break;
            }

            case "/play":

                await handleTelegramStart(chatId);

                break;

            case "/balance": {

                // Always look up the balance using the Telegram user's own
                // account ID. Never use a balance supplied by the client.
                const telegramId = String(
                    message.from?.id || chatId
                );

                // Use the same server-side account balance used by the game
                // room. This makes /balance show the CURRENT available balance,
                // including purchases and winnings.
                const account = getDepositedAccount(telegramId, `tg:${telegramId}`, null);
                const availableBalance = Math.max(0, Number(account?.balance || 0));

                await sendTelegramMessage(
                    chatId,
                    `💰 EDILBINGO BALANCE\n\n` +
                    `(Available): ${availableBalance.toFixed(2)} ETB`
                );

                break;
            }

            case "/deposit":

                await sendTelegramMessage(
                    chatId,
                    `💳 የተቀማጭ መንገድ ይምረጡ። (Select Deposit Method)\n\n` +
                    `ከታች ያሉትን መንገዶች መርጠው ይቀጥሉ።`,
                    {
                        inline_keyboard: [
                            [
                                {
                                    text: "CBE BIRR",
                                    callback_data: "deposit_cbe"
                                },
                                {
                                    text: "TELE BIRR",
                                    callback_data: "deposit_tele"
                                }
                            ]
                        ]
                    }
                );

                break;

            case "/withdraw": {
                const baseUrl = MINI_APP_URL ? MINI_APP_URL.replace(/\/+$/, "") : "";
                if (!baseUrl) {
                    await sendTelegramMessage(chatId, "⚠️ Withdraw Mini App is not configured. Set MINI_APP_URL first.");
                    break;
                }

                await sendTelegramMessage(
                    chatId,
                    "📤 እባክዎ የሚያወጡት (Withdraw)\n\nከታች ያለውን Withdraw ቅጽ ይሙሉ።",
                    {
                        inline_keyboard: [[
                            {
                                text: "📤 Open Withdraw",
                                web_app: { url: `${baseUrl}/telegram-withdraw.html` }
                            }
                        ]]
                    }
                );
                break;
            }

            case "/history": {

                const telegramId = String(message.from?.id || chatId);
                const isAdmin = isTelegramAdmin(telegramId);

                // Players can view only their own deposit/withdrawal history.
                // The configured administrator also gets an all-players history
                // option without changing the normal player menu.
                const historyButtons = [
                    [
                        { text: "💰 Deposit History", callback_data: "history_deposits" },
                        { text: "📤 Withdrawal History", callback_data: "history_withdrawals" }
                    ]
                ];

                if (isAdmin) {
                    historyButtons.push([
                        { text: "📋 All Players Transaction History", callback_data: "history_all" }
                    ]);
                }

                await sendTelegramMessage(
                    chatId,
                    isAdmin
                        ? `📋 TRANSACTION HISTORY\n\nSelect the history you want to view:`
                        : `📋 TRANSACTION HISTORY\n\nSelect your history:` ,
                    { inline_keyboard: historyButtons }
                );

                break;
            }

            case "/instructions":

                await sendTelegramMessage(
                    chatId,
                    `ℹ️ የእድል ጨዋታ (Game Rules)\n\n` +
                    `🎯 የአሸናፊነት መንገዶች\n\n` +
                    `1️⃣ መስመር (LINE)\n` +
                    `B   I   N   G   O\n` +
                    `+---+---+---+---+---+\n` +
                    `| ✅| ✅| ✅| ✅| ✅|  ← መስመር\n` +
                    `+---+---+---+---+---+\n` +
                    `|   |   |   |   |   |\n` +
                    `|   |   |   |   |   |\n` +
                    `|   |   |   |   |   |\n` +
                    `|   |   |   |   |   |\n` +
                    `+---+---+---+---+---+\n\n` +
                    `2️⃣ አራት ማዕዘናት (4 CORNERS)\n` +
                    `B   I   N   G   O\n` +
                    `+---+---+---+---+---+\n` +
                    `| ✅|   |   |   | ✅|  ← 4 ማዕዘናት\n` +
                    `|   |   |   |   |   |\n` +
                    `|   |   |   |   |   |\n` +
                    `|   |   |   |   |   |\n` +
                    `|   |   |   |   |   |\n` +
                    `|   |   |   |   |   |\n` +
                    `|   |   |   |   |   |\n` +
                    `|   |   |   |   |   |\n` +
                    `|   |   |   |   |   |\n` +
                    `+---+---+---+---+---+\n` +
                    `|   |   |   |   |   |\n` +
                    `|   |   |   |   |   |\n` +
                    `|   |   |   |   |   |\n` +
                    `|   |   |   |   |   |\n` +
                    `|   |   |   |   |   |\n` +
                    `|   |   |   |   |   |\n` +
                    `|   |   |   |   |   |\n` +
                    `|   |   |   |   |   |\n` +
                    `|   |   |   |   |   |\n` +
                    `+---+---+---+---+---+\n\n` +
                    `📌 በተጠራ ቁጥር በካርድዎ ላይ ምልክት ያድርጉ።\n` +
                    `🏆 ከላይ ካሉት የአሸናፊነት መንገዶች አንዱን ሲሞሉ BINGO ይጫኑ።\n` +
                    `⚠️ የተጠራ ቁጥር ብቻ ነው ምልክት ማድረግ የሚቻለው።`
                );

                break;

            case "/register":

                if (isTelegramUserRegistered(chatId)) {
                    await sendTelegramMessage(
                        chatId,
                        "✅ You are already registered with EdilBingo."
                    );
                } else {
                    await sendRegistrationPrompt(chatId);
                }

                break;

            // ================================================
            // START
            // ================================================

            case "/start":

                await handleTelegramStart(
                    chatId
                );

                break;

            // ================================================
            // NEW GAME
            // ================================================

            case "/newgame":

                await handleTelegramNewGame(
                    chatId,
                    roomId
                );

                break;

            // ================================================
            // DRAW
            // ================================================

            case "/draw":

                await handleTelegramDraw(
                    chatId,
                    roomId
                );

                break;

            // ================================================
            // STATUS
            // ================================================

            case "/status":

                await handleTelegramStatus(
                    chatId,
                    roomId
                );

                break;

            // ================================================
            // STOP
            // ================================================

            case "/stop":

                await handleTelegramStop(
                    chatId,
                    roomId
                );

                break;

            // ================================================
            // UNKNOWN COMMAND
            // ================================================

            default:

                await sendTelegramMessage(

                    chatId,

`🎱 EDILBINGO

Available commands:

/start

/newgame vip
/newgame superbingo
/newgame edilbingo

/draw vip
/draw superbingo
/draw edilbingo

/status vip
/status superbingo
/status edilbingo

/stop vip
/stop superbingo
/stop edilbingo`

                );

                break;

        }

    } catch (error) {

        console.error(
            "Telegram command error:",
            error.message
        );

    }

}

// ============================================================
// TELEGRAM DEPOSIT METHOD CALLBACKS
// ============================================================

async function processTelegramCallbackQuery(callbackQuery) {

    if (!callbackQuery || !callbackQuery.id) {
        return;
    }

    const data = String(callbackQuery.data || "");
    const chatId = callbackQuery.message?.chat?.id;

    try {
        await telegramRequest("answerCallbackQuery", {
            callback_query_id: callbackQuery.id
        });

        if (!chatId) {
            return;
        }

        const telegramId = String(callbackQuery.from?.id || chatId);

        const approveMatch = data.match(/^deposit_approve_(\d+)$/);
        const rejectMatch = data.match(/^deposit_reject_(\d+)$/);
        if (approveMatch || rejectMatch) {
            if (!isTelegramAdmin(telegramId)) {
                await sendTelegramMessage(chatId, "❌ Admin access required.");
                return;
            }
            const requestId = Number((approveMatch || rejectMatch)[1]);
            try {
                if (approveMatch) {
                    const result = await approveDepositRequest(requestId, telegramId);
                    await sendTelegramMessage(
                        chatId,
                        `✅ Deposit #${requestId} approved. ${Number(result.request.requested_amount).toFixed(2)} ETB added.`
                    );
                } else {
                    await rejectDepositRequest(requestId, telegramId);
                    await sendTelegramMessage(chatId, `❌ Deposit #${requestId} rejected.`);
                }
            } catch (error) {
                await sendTelegramMessage(chatId, `❌ Deposit #${requestId}: ${error.message}`);
            }
            return;
        }

        // ============================================================
        // TRANSACTION HISTORY
        // ============================================================
        // Players see only their own transactions. The configured admin
        // can additionally see the combined transaction history of all
        // registered players.
        if (data === "history_deposits" || data === "history_withdrawals" || data === "history_all") {
            const isAdmin = isTelegramAdmin(telegramId);

            if (data === "history_all" && !isAdmin) {
                await sendTelegramMessage(chatId, "❌ Admin access required.");
                return;
            }

            let rows = [];
            let title = "";

            if (data === "history_all") {
                rows = db.prepare(`
                    SELECT t.id, t.type, t.amount, t.status, t.reference, t.description, t.created_at,
                           u.telegram_id, u.first_name, u.username, u.phone_number
                    FROM transactions t
                    JOIN users u ON u.id = t.user_id
                    ORDER BY t.id DESC
                `).all();
                title = "📋 ALL PLAYERS TRANSACTION HISTORY";
            } else {
                const type = data === "history_deposits" ? "deposit" : "withdrawal";
                title = type === "deposit" ? "💰 DEPOSIT HISTORY" : "📤 WITHDRAWAL HISTORY";

                const user = db.prepare(`
                    SELECT id FROM users WHERE telegram_id = ? LIMIT 1
                `).get(telegramId);

                if (!user) {
                    await sendTelegramMessage(chatId, "❌ Your account is not registered yet.");
                    return;
                }

                rows = db.prepare(`
                    SELECT id, type, amount, status, reference, description, created_at
                    FROM transactions
                    WHERE user_id = ? AND type = ?
                    ORDER BY id DESC
                `).all(user.id, type);
            }

            if (!rows.length) {
                await sendTelegramMessage(chatId, `${title}\n\nNo transactions found.`);
                return;
            }

            const lines = rows.map((row, index) => {
                const amount = Number(row.amount || 0).toFixed(2);
                const date = row.created_at || "—";
                const status = row.status || "completed";

                if (data === "history_all") {
                    const name = row.first_name || row.username || row.telegram_id || "Unknown";
                    const phone = row.phone_number ? `\n   📱 ${row.phone_number}` : "";
                    return `${index + 1}. ${row.type === "deposit" ? "💰" : "📤"} ${row.type.toUpperCase()}\n` +
                        `   👤 ${name}\n` +
                        `   🆔 ${row.telegram_id}${phone}\n` +
                        `   💵 ${amount} ETB\n` +
                        `   📌 ${status}\n` +
                        `   🕒 ${date}`;
                }

                return `${index + 1}. ${row.type === "deposit" ? "💰" : "📤"} ${amount} ETB\n` +
                    `   📌 ${status}\n` +
                    `   🕒 ${date}`;
            });

            const header = data === "history_all"
                ? `${title}\n\nTotal transactions: ${rows.length}`
                : `${title}\n\nYour transactions: ${rows.length}`;

            // Telegram messages are limited to 4096 characters. Send the
            // complete history in safe-sized chunks rather than silently
            // truncating older transactions.
            let chunk = header;
            for (const line of lines) {
                const candidate = `${chunk}\n\n${line}`;
                if (candidate.length > 3800) {
                    await sendTelegramMessage(chatId, chunk);
                    chunk = `${title}\n\n${line}`;
                } else {
                    chunk = candidate;
                }
            }
            if (chunk) {
                await sendTelegramMessage(chatId, chunk);
            }
            return;
        }

        if (data === "admin_search_phone") {
            if (!isTelegramAdmin(telegramId)) {
                await sendTelegramMessage(chatId, "❌ Admin access required.");
                return;
            }
            pendingAdminPhoneSearch.add(telegramId);
            await sendTelegramMessage(
                chatId,
                "🔎 Search By Phone Number\n\nSend the customer's phone number, for example:\n+251910970993\n\nThe registered customer's Telegram ID will be shown."
            );
            return;
        }

        if (data === "admin_add_balance") {
            if (!isTelegramAdmin(telegramId)) {
                await sendTelegramMessage(chatId, "❌ Admin access required.");
                return;
            }
            await sendTelegramMessage(
                chatId,
                "💰 Add Balance\n\nUse:\n/addbalance TELEGRAM_ID AMOUNT\n\nExample:\n/addbalance 456801294 400"
            );
            return;
        }

        if (data.startsWith("withdraw_approve:") || data.startsWith("withdraw_reject:")) {
            if (!isTelegramAdmin(telegramId)) {
                await sendTelegramMessage(chatId, "❌ Admin access required.");
                return;
            }
            const [action, idText] = data.split(":");
            const requestId = Number(idText);
            const request = db.prepare(`SELECT wr.*, u.first_name, u.username, u.balance FROM withdrawal_requests wr JOIN users u ON u.id = wr.user_id WHERE wr.id = ? LIMIT 1`).get(requestId);
            if (!request) { await sendTelegramMessage(chatId, "❌ Withdrawal request not found."); return; }
            if (request.status !== "pending") { await sendTelegramMessage(chatId, `ℹ️ Request #${requestId} is already ${request.status}.`); return; }

            if (action === "withdraw_reject") {
                db.prepare(`UPDATE withdrawal_requests SET status='rejected', admin_id=?, processed_at=CURRENT_TIMESTAMP WHERE id=?`).run(telegramId, requestId);
                await sendTelegramMessage(request.telegram_id,
                    `❌ Withdrawal Rejected\\n\\n` +
                    `🆔 Request: #${requestId}\\n` +
                    `💰 Amount: ${Number(request.amount).toFixed(2)} ETB\\n\\n` +
                    `Your withdrawal request was rejected by the administrator.`
                );
                await sendTelegramMessage(chatId, `❌ Withdrawal #${requestId} rejected.`);
                return;
            }

            const amount = Number(request.amount);
            const result = db.transaction(() => {
                const fresh = db.prepare(`SELECT balance FROM users WHERE id=?`).get(request.user_id);
                const balance = Number(fresh?.balance || 0);
                if (balance < amount) throw new Error("Insufficient balance at approval time.");
                db.prepare(`UPDATE users SET balance = balance - ? WHERE id=?`).run(amount, request.user_id);
                db.prepare(`UPDATE withdrawal_requests SET status='approved', admin_id=?, processed_at=CURRENT_TIMESTAMP WHERE id=?`).run(telegramId, requestId);
                db.prepare(`INSERT INTO transactions (user_id, type, amount, reference, status, description) VALUES (?, 'withdrawal', ?, ?, 'completed', ?)`).run(request.user_id, amount, `withdrawal:${requestId}`, `Withdrawal approved by admin ${telegramId}`);
                return balance - amount;
            })();

            await sendTelegramMessage(request.telegram_id,
                `✅ Withdrawal Approved\\n\\n` +
                `🆔 Request: #${requestId}\\n` +
                `💰 Amount: ${amount.toFixed(2)} ETB\\n` +
                `💵 Remaining balance: ${Number(result).toFixed(2)} ETB\\n\\n` +
                `Your withdrawal has been approved.`
            );
            await sendTelegramMessage(chatId, `✅ Withdrawal #${requestId} approved.\\n💰 ${amount.toFixed(2)} ETB`);
            return;
        }

        if (data === "deposit_cbe" || data === "deposit_tele") {
            const method = data === "deposit_cbe" ? "CBE Birr" : "Telebirr";
            pendingDepositInputs.set(telegramId, { step: "amount", method });

            const instructions = method === "CBE Birr"
                ? `💳 CBE-Birr አማራጭ\nCBE-BIRR Merchant - +251921976723 (Kirubel)`
                : `📱 TELE-Birr አማራጭ\nMerchant ID - 715516 (Kirubel)`;

            await sendTelegramMessage(
                chatId,
                `${instructions}\n\n` +
                `ክፍያውን ካደረጉ በኋላ ለDeposit ማመልከቻዎ የሚጠይቁትን መጠን በETB ይጻፉ።\n` +
                `ለምሳሌ: 100`
            );
            return;
        }

    } catch (error) {
        console.error(
            "Telegram callback error:",
            error.message
        );
    }

}

// ============================================================
// TELEGRAM WITHDRAW MINI APP
// ============================================================

app.get("/api/withdraw/info", (req, res) => {
    const initData = req.get("x-telegram-init-data") || "";
    const user = verifyTelegramInitData(initData);
    if (!user) return res.status(401).json({ success: false, message: "Open Withdraw from Telegram." });

    const account = db.prepare(`
        SELECT id, telegram_id, first_name, username
        FROM users WHERE telegram_id = ? LIMIT 1
    `).get(user.id);
    if (!account) return res.status(404).json({ success: false, message: "Please register your Telegram account first." });

    const wallet = getDepositedAccount(String(user.id), `tg:${user.id}`, null);

    return res.json({
        success: true,
        user: {
            telegramId: account.telegram_id,
            firstName: account.first_name || "",
            username: account.username || "",
            balance: Number(wallet.balance || 0)
        }
    });
});

app.post("/api/withdraw/submit", async (req, res) => {
    const initData = req.get("x-telegram-init-data") || "";
    const user = verifyTelegramInitData(initData);
    if (!user) return res.status(401).json({ success: false, message: "Open Withdraw from Telegram." });

    const account = db.prepare(`SELECT id, telegram_id, first_name, username, balance FROM users WHERE telegram_id = ? LIMIT 1`).get(user.id);
    if (!account) return res.status(404).json({ success: false, message: "Please register your Telegram account first." });

    const method = String(req.body?.method || "").trim();
    const accountName = String(req.body?.accountName || "").trim();
    const phone = String(req.body?.phone || "").trim();
    const amount = Number(req.body?.amount);
    if (!method || !accountName || !phone || !Number.isFinite(amount) || amount <= 0) {
        return res.status(400).json({ success: false, message: "Please complete all withdrawal fields." });
    }
    if (amount > Number(account.balance || 0)) {
        return res.status(400).json({ success: false, message: "Insufficient balance." });
    }

    const cleanAmount = Number(amount.toFixed(2));
    const request = db.transaction(() => {
        const result = db.prepare(`INSERT INTO withdrawal_requests (user_id, telegram_id, method, account_name, phone_number, amount, status) VALUES (?, ?, ?, ?, ?, ?, 'pending')`).run(account.id, account.telegram_id, method, accountName, phone, cleanAmount);
        return Number(result.lastInsertRowid);
    })();

    const adminText = `Dear እድልBinጎ!\n\n` +
        `You have new withdrawal request.\n\n` +
        `🆔 Request: #${request}\n` +
        `👤 Telegram ID: ${account.telegram_id}\n` +
        `👤 Name: ${account.first_name || "—"}\n` +
        `📱 Phone: ${phone}\n` +
        `💳 Method: ${method}\n` +
        `💰 Amount: ${cleanAmount.toFixed(2)} ETB`;

    if (ADMIN_TELEGRAM_ID) {
        try {
            // Approval/rejection controls are available in the Admin Home
            // Pending Withdrawals section, so keep the Telegram notification text-only.
            await sendTelegramMessage(ADMIN_TELEGRAM_ID, adminText);
        } catch (e) {
            console.error("Withdrawal admin notification failed:", e.message);
        }
    }

    try {
        await sendTelegramMessage(account.telegram_id,
            `📤 Withdrawal Request Received\\n\\n` +
            `🆔 Request: #${request}\\n` +
            `💰 Amount: ${cleanAmount.toFixed(2)} ETB\\n` +
            `💳 Method: ${method}\\n\\n` +
            `⏳ Your request is waiting for administrator approval.`
        );
    } catch (e) {
        console.error("Withdrawal player notification failed:", e.message);
    }

    return res.json({ success: true, requestId: request, message: `Withdrawal request #${request} submitted successfully.` });
});

// ============================================================
// TELEGRAM ADMIN HOME MINI APP
// ============================================================

app.get("/api/admin/home", (req, res) => {
    const admin = getVerifiedAdminFromRequest(req);
    if (!admin) {
        return res.status(403).json({ success: false, message: "Admin access required." });
    }

    const announcements = db.prepare(`
        SELECT id, title, message, sent_count, failed_count, created_at
        FROM admin_announcements
        ORDER BY id DESC
        LIMIT 30
    `).all();

    const withdrawals = db.prepare(`
        SELECT wr.id, wr.telegram_id, wr.method, wr.account_name, wr.phone_number, wr.amount, wr.status, wr.created_at,
               u.first_name, u.username
        FROM withdrawal_requests wr
        JOIN users u ON u.id = wr.user_id
        WHERE wr.status = 'pending'
        ORDER BY wr.id DESC
        LIMIT 50
    `).all();

    return res.json({
        success: true,
        admin,
        announcements,
        withdrawals
    });
});

async function processAdminWithdrawalRequest(requestId, action, adminTelegramId) {
    const request = db.prepare(`SELECT wr.*, u.first_name, u.username, u.balance FROM withdrawal_requests wr JOIN users u ON u.id = wr.user_id WHERE wr.id = ? LIMIT 1`).get(requestId);
    if (!request) throw new Error("Withdrawal request not found.");
    if (request.status !== 'pending') throw new Error(`Request #${requestId} is already ${request.status}.`);

    if (action === 'reject') {
        db.prepare(`UPDATE withdrawal_requests SET status='rejected', admin_id=?, processed_at=CURRENT_TIMESTAMP WHERE id=?`).run(adminTelegramId, requestId);
        try {
            await sendTelegramMessage(request.telegram_id,
                `❌ Withdrawal Rejected\n\n` +
                `🆔 Request: #${requestId}\n` +
                `💰 Amount: ${Number(request.amount).toFixed(2)} ETB\n\n` +
                `Your withdrawal request was rejected by the administrator.`
            );
        } catch (e) { console.error('Withdrawal player rejection notification failed:', e.message); }
        return { status: 'rejected', amount: Number(request.amount) };
    }

    const amount = Number(request.amount);
    const result = db.transaction(() => {
        const fresh = db.prepare(`SELECT balance FROM users WHERE id=?`).get(request.user_id);
        const balance = Number(fresh?.balance || 0);
        if (balance < amount) throw new Error('Insufficient balance at approval time.');
        db.prepare(`UPDATE users SET balance = balance - ? WHERE id=?`).run(amount, request.user_id);
        db.prepare(`UPDATE withdrawal_requests SET status='approved', admin_id=?, processed_at=CURRENT_TIMESTAMP WHERE id=?`).run(adminTelegramId, requestId);
        db.prepare(`INSERT INTO transactions (user_id, type, amount, reference, status, description) VALUES (?, 'withdrawal', ?, ?, 'completed', ?)`).run(request.user_id, amount, `withdrawal:${requestId}`, `Withdrawal approved by admin ${adminTelegramId}`);
        return balance - amount;
    })();
    setAccountBalance(request.telegram_id, `tg:${request.telegram_id}`, result);

    try {
        await sendTelegramMessage(request.telegram_id,
            `✅ Withdrawal Approved\n\n`
            `🆔 Request: #${requestId}\n` +
            `💰 Amount: ${amount.toFixed(2)} ETB\n` +
            `💵 Remaining balance: ${Number(result).toFixed(2)} ETB\n\n` +
            `Your withdrawal has been approved.`
        );
    } catch (e) { console.error('Withdrawal player approval notification failed:', e.message); }
    return { status: 'approved', amount, remainingBalance: Number(result) };
}

app.post("/api/admin/withdrawal/:id/:action", async (req, res) => {
    const admin = getVerifiedAdminFromRequest(req);
    if (!admin) return res.status(403).json({ success: false, message: 'Admin access required.' });
    const action = req.params.action === 'approve' ? 'approve' : (req.params.action === 'reject' ? 'reject' : null);
    if (!action) return res.status(400).json({ success: false, message: 'Invalid withdrawal action.' });
    try {
        const result = await processAdminWithdrawalRequest(Number(req.params.id), action, String(admin.telegram_id || ADMIN_TELEGRAM_ID));
        return res.json({ success: true, message: action === 'approve' ? `Withdrawal #${req.params.id} approved.` : `Withdrawal #${req.params.id} rejected.`, result });
    } catch (e) {
        return res.status(400).json({ success: false, message: e.message });
    }
});

app.get("/api/admin/deposit-requests", (req, res) => {
    const admin = getVerifiedAdminFromRequest(req);
    if (!admin) return res.status(403).json({ success: false, message: "Admin access required." });

    const status = String(req.query?.status || "pending");
    const rows = db.prepare(`
        SELECT dr.id, dr.telegram_id, dr.method, dr.requested_amount,
               dr.detected_amount, dr.detected_phone, dr.status,
               dr.created_at, dr.processed_at,
               u.first_name, u.username, u.phone_number, u.balance
        FROM deposit_requests dr
        JOIN users u ON u.id = dr.user_id
        WHERE dr.status = ?
        ORDER BY dr.id DESC
    `).all(status);

    return res.json({ success: true, requests: rows });
});

app.post("/api/admin/deposit-requests/:id/approve", async (req, res) => {
    const admin = getVerifiedAdminFromRequest(req);
    if (!admin) return res.status(403).json({ success: false, message: "Admin access required." });
    try {
        const result = await approveDepositRequest(Number(req.params.id), String(admin.telegram_id || ADMIN_TELEGRAM_ID));
        return res.json({
            success: true,
            status: "approved",
            requestId: Number(req.params.id),
            amount: Number(result.request.requested_amount),
            balance: result.newBalance
        });
    } catch (e) {
        return res.status(400).json({ success: false, message: e.message });
    }
});

app.post("/api/admin/deposit-requests/:id/reject", async (req, res) => {
    const admin = getVerifiedAdminFromRequest(req);
    if (!admin) return res.status(403).json({ success: false, message: "Admin access required." });
    try {
        await rejectDepositRequest(Number(req.params.id), String(admin.telegram_id || ADMIN_TELEGRAM_ID));
        return res.json({ success: true, status: "rejected", requestId: Number(req.params.id) });
    } catch (e) {
        return res.status(400).json({ success: false, message: e.message });
    }
});

app.post("/api/admin/sms-check-add", async (req, res) => {
    const admin = getVerifiedAdminFromRequest(req);
    if (!admin) return res.status(403).json({ success: false, message: "Admin access required." });

    const smsText = String(req.body?.smsText || "").trim();
    const requestedAmount = Number(req.body?.requestedAmount ?? req.body?.amount);
    const method = String(req.body?.method || "Unknown");

    if (!smsText) return res.status(400).json({ success: false, message: "Paste the SMS text." });
    if (!Number.isFinite(requestedAmount) || requestedAmount <= 0) {
        return res.status(400).json({ success: false, message: "Enter the customer's requested deposit amount." });
    }

    const amount = Number(requestedAmount.toFixed(2));
    const detectedAmount = extractDepositAmountFromSms(smsText);
    const phone = extractPhoneFromSms(smsText);

    if (!phone || !Number.isFinite(detectedAmount)) {
        return res.status(400).json({ success: false, message: "Could not identify the customer phone number and paid amount from this SMS." });
    }
    if (Math.abs(detectedAmount - amount) > 0.001) {
        return res.status(400).json({
            success: false,
            message: `Amount mismatch: requested ${amount.toFixed(2)} ETB, SMS shows ${detectedAmount.toFixed(2)} ETB. No deposit was made.`
        });
    }

    const normalizedPhone = phone.replace(/^\+251/, "0");
    const user = db.prepare(`
        SELECT id, telegram_id, first_name, username, phone_number, balance
        FROM users
        WHERE REPLACE(REPLACE(phone_number, ' ', ''), '+251', '0') = ?
        LIMIT 1
    `).get(normalizedPhone);

    if (!user) return res.status(404).json({ success: false, message: `No registered account found for ${phone}.` });

    const duplicate = db.prepare(`SELECT id, status FROM deposit_requests WHERE sms_text = ? LIMIT 1`).get(smsText);
    if (duplicate) {
        return res.status(409).json({ success: false, message: `This SMS already belongs to deposit request #${duplicate.id} (${duplicate.status}).` });
    }

    const result = db.prepare(`
        INSERT INTO deposit_requests
            (user_id, telegram_id, method, requested_amount, sms_text, detected_amount, detected_phone, status)
        VALUES (?, ?, ?, ?, ?, ?, ?, 'pending')
    `).run(user.id, user.telegram_id, method, amount, smsText, detectedAmount, phone);

    await notifyPendingDepositCreated(Number(result.lastInsertRowid), user, method, amount, detectedAmount);

    return res.json({
        success: true,
        status: "pending",
        requestId: Number(result.lastInsertRowid),
        message: "Deposit is pending verification. Customer was notified and balance was NOT changed.",
        amount,
        phone
    });
});


app.post("/api/admin/broadcast", async (req, res) => {
    const admin = getVerifiedAdminFromRequest(req);
    if (!admin) {
        return res.status(403).json({ success: false, message: "Admin access required." });
    }

    const title = String(req.body?.title || "").trim();
    const message = String(req.body?.message || "").trim();
    if (!title || !message) {
        return res.status(400).json({ success: false, message: "Title and message are required." });
    }

    const users = db.prepare(`SELECT telegram_id FROM users WHERE telegram_id IS NOT NULL AND telegram_id <> ''`).all();
    let sent = 0;
    let failed = 0;
    const text = `📢 ${title}\n\n${message}`;

    for (const user of users) {
        try {
            await sendTelegramMessage(user.telegram_id, text);
            sent += 1;
        } catch (error) {
            failed += 1;
            console.error("Broadcast failed:", error.message);
        }
    }

    const result = db.prepare(`
        INSERT INTO admin_announcements (title, message, sent_count, failed_count)
        VALUES (?, ?, ?, ?)
    `).run(title, message, sent, failed);

    return res.json({ success: true, id: result.lastInsertRowid, sent, failed });
});

// ============================================================
// TELEGRAM LONG POLLING
// ============================================================

let telegramOffset = 0;

async function startTelegramBot() {

    if (!TELEGRAM_BOT_TOKEN) {

        console.log(
            "Telegram bot disabled: no TELEGRAM_BOT_TOKEN."
        );

        return;

    }

    console.log(
        "Starting EDILBINGO Telegram bot..."
    );

    try {

        const me =
            await telegramRequest(
                "getMe"
            );

        console.log(
            `Telegram bot connected: @${me.username}`
        );

        // ====================================================
        // TELEGRAM COMMAND MENU
        // ====================================================
        // These are the public player commands shown when the
        // user types "/" in Telegram.
        await telegramRequest(
            "setMyCommands",
            {
                scope: { type: "default" },
                commands: [
                    { command: "home", description: "Home 🏠" },
                    { command: "play", description: "Play 🎮" },
                    { command: "balance", description: "My balance" },
                    { command: "deposit", description: "Deposit" },
                    { command: "withdraw", description: "Withdraw" },
                    { command: "history", description: "Transaction history" },
                    { command: "instructions", description: "Instruction" },
                    { command: "register", description: "Register" }
                ]
            }
        );

        console.log(
            "Telegram player command menu configured."
        );

        // Add the two extra admin commands only to the configured admin's
        // Telegram command menu. Other users keep the existing menu unchanged.
        if (ADMIN_TELEGRAM_ID) {
            await telegramRequest(
                "setMyCommands",
                {
                    commands: [
                        { command: "home", description: "Home 🏠" },
                        { command: "myid", description: "My Telegram ID 🆔" },
                        { command: "admin", description: "Admin status 🛡️" },
                        { command: "searchphone", description: "Search By Phone Number 🔎" },
                        { command: "addbalance", description: "Add Balance 💰" },
                        { command: "play", description: "Play 🎮" },
                        { command: "balance", description: "My balance" },
                        { command: "deposit", description: "Deposit" },
                        { command: "withdraw", description: "Withdraw" },
                        { command: "history", description: "Transaction history" },
                        { command: "instructions", description: "Instruction" },
                        { command: "register", description: "Register" }
                    ],
                    scope: { type: "chat", chat_id: ADMIN_TELEGRAM_ID }
                }
            );
            console.log("Telegram admin command menu configured.");
        }

        // Make the bottom Telegram "Menu" button open the
        // command list instead of another menu type.
        await telegramRequest(
            "setChatMenuButton",
            {
                menu_button: {
                    type: "commands"
                }
            }
        );

        console.log(
            "Telegram bottom Menu button configured to show commands."
        );

        if (!MINI_APP_URL) {

            console.warn(
                "WARNING: MINI_APP_URL is missing."
            );

        } else {

            console.log(
                "Mini App URL:",
                MINI_APP_URL
            );

        }

    } catch (error) {

        console.error(
            "Telegram bot connection failed:",
            error.message
        );

        return;

    }

    // ========================================================
    // LONG POLLING LOOP
    // ========================================================

    while (true) {

        try {

            const updates =
                await telegramRequest(

                    "getUpdates",

                    {

                        offset:
                            telegramOffset,

                        timeout:
                            30

                    }

                );

            for (
                const update of updates
            ) {

                telegramOffset =
                    update.update_id + 1;

                if (
                    update.message
                ) {

                    await processTelegramMessage(
                        update.message
                    );

                } else if (
                    update.callback_query
                ) {

                    await processTelegramCallbackQuery(
                        update.callback_query
                    );

                }

            }

        } catch (error) {

            console.error(
                "Telegram polling error:",
                error.message
            );

            await new Promise(
                resolve =>
                    setTimeout(
                        resolve,
                        5000
                    )
            );

        }

    }

}

// ============================================================
// START SERVER
// ============================================================

server.listen(
    PORT,
    () => {

        console.log("");

        console.log(
            "========================================"
        );

        console.log(
            `EDILBINGO server running at http://localhost:${PORT}`
        );

        console.log(
            "Socket.IO enabled."
        );

        console.log("");

        console.log(
            "Rooms:"
        );

        Object.values(rooms)
            .forEach(room => {

                console.log(
                    `  ${room.id} -> ${room.name}${room.id === BONUS_ROOM_ID ? " - DEDICATED PREDICTION ROOM" : ` - ${room.entryFee} ETB`}`
                );

            });

        console.log("");

        console.log(
            "VIP room enabled: YES"
        );

        console.log("");

        console.log(
            "========================================"
        );

        // Start only the Bingo engine rooms. A player is not required for VIP;
        // selection -> playing -> selection keeps running. SuperBingo must always
        // open in selection mode after a server restart and is separately scheduled.
        // GoodBingo Bonus is never started by this Bingo engine..
        const superbingoRoom = rooms.superbingo;
        stopAutoDraw(superbingoRoom.id);
        stopAutoStart(superbingoRoom.id);
        resetRoom(superbingoRoom);
        scheduleAutoStart(superbingoRoom.id);

        // Only Bingo rooms are started by the Bingo engine. GoodBingo Bonus
        // is deliberately excluded because it is a dedicated prediction room.
        Object.values(rooms)
            .filter(room => room.id === "vip")
            .forEach(room => scheduleAutoStart(room.id));

        startTelegramBot();

    }
);