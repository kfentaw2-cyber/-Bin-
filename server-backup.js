require("dotenv").config();

const express = require("express");
const http = require("http");
const { Server } = require("socket.io");

const app = express();
const server = http.createServer(app);
const io = new Server(server);

app.use(express.json());
app.use(express.static("public"));

const PORT = process.env.PORT || 3000;

// ======================================================
// TELEGRAM CONFIGURATION
// ======================================================

const TELEGRAM_BOT_TOKEN = process.env.TELEGRAM_BOT_TOKEN;

if (!TELEGRAM_BOT_TOKEN) {
    console.warn(
        "WARNING: TELEGRAM_BOT_TOKEN is not configured."
    );
}

// ======================================================
// GAME STATE
// ======================================================

let calledNumbers = [];
let gameStarted = false;

// ======================================================
// BINGO NUMBER
// ======================================================

function drawNumber() {

    if (calledNumbers.length >= 75) {
        return null;
    }

    let number;

    do {
        number = Math.floor(Math.random() * 75) + 1;
    } while (calledNumbers.includes(number));

    calledNumbers.push(number);

    return number;
}

// ======================================================
// BINGO LETTER
// ======================================================

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

// ======================================================
// CREATE DRAW RESULT
// ======================================================

function createDrawResult(number) {

    const letter = getLetter(number);

    return {
        number: number,
        letter: letter,
        display: `${letter}-${number}`,
        totalCalled: calledNumbers.length
    };
}

// ======================================================
// DRAW NUMBER FOR THE GAME
// ======================================================

function performDraw() {

    if (!gameStarted) {
        return {
            success: false,
            message: "Game has not started."
        };
    }

    const number = drawNumber();

    if (number === null) {
        return {
            success: false,
            message: "All 75 numbers have been called."
        };
    }

    const result = createDrawResult(number);

    console.log(
        `NUMBER DRAWN: ${result.display}`
    );

    // Send to website players
    io.emit("numberCalled", result);

    return {
        success: true,
        ...result
    };
}

// ======================================================
// API - STATUS
// ======================================================

app.get("/api/status", (req, res) => {

    res.json({
        success: true,
        game: "EDILBINGO",
        gameStarted: gameStarted,
        totalCalled: calledNumbers.length,
        calledNumbers: calledNumbers,
        remainingNumbers: 75 - calledNumbers.length
    });

});

// ======================================================
// API - START GAME
// ======================================================

app.post("/api/start-game", (req, res) => {

    calledNumbers = [];
    gameStarted = true;

    console.log("GAME STARTED FROM API");

    io.emit("gameStarted", {
        gameStarted: true,
        calledNumbers: [],
        totalCalled: 0
    });

    res.json({
        success: true,
        message: "EDILBINGO game started.",
        gameStarted: true
    });

});

// ======================================================
// API - DRAW NUMBER
// ======================================================

app.post("/api/draw-number", (req, res) => {

    const result = performDraw();

    if (!result.success) {

        return res.status(400).json(result);

    }

    res.json(result);

});

// ======================================================
// API - NEW GAME
// ======================================================

app.post("/api/new-game", (req, res) => {

    calledNumbers = [];
    gameStarted = true;

    console.log("NEW GAME FROM API");

    io.emit("newGameStarted", {
        gameStarted: true,
        calledNumbers: [],
        totalCalled: 0
    });

    res.json({
        success: true,
        message: "New EDILBINGO game started.",
        gameStarted: true
    });

});

// ======================================================
// API - STOP GAME
// ======================================================

app.post("/api/stop-game", (req, res) => {

    gameStarted = false;

    console.log("GAME STOPPED");

    io.emit("gameStopped", {
        gameStarted: false
    });

    res.json({
        success: true,
        message: "EDILBINGO game stopped.",
        gameStarted: false
    });

});

// ======================================================
// SOCKET.IO
// ======================================================

io.on("connection", (socket) => {

    console.log(
        "Player connected:",
        socket.id
    );

    // --------------------------------------------------
    // JOIN ROOM
    // --------------------------------------------------

    socket.on("joinRoom", (roomId) => {

        if (!roomId) {

            socket.emit(
                "errorMessage",
                "Room ID is required."
            );

            return;
        }

        socket.join(roomId);

        console.log(
            socket.id,
            "joined room:",
            roomId
        );

        socket.emit("gameState", {

            calledNumbers: calledNumbers,

            gameStarted: gameStarted,

            totalCalled: calledNumbers.length

        });

    });

    // --------------------------------------------------
    // START GAME
    // --------------------------------------------------

    socket.on("startGame", () => {

        gameStarted = true;

        calledNumbers = [];

        console.log("GAME STARTED");

        io.emit("gameStarted", {

            gameStarted: true,

            calledNumbers: [],

            totalCalled: 0

        });

    });

    // --------------------------------------------------
    // DRAW NUMBER
    // --------------------------------------------------

    socket.on("drawNumber", () => {

        console.log(
            "Draw number request received"
        );

        const result = performDraw();

        if (!result.success) {

            socket.emit(
                "errorMessage",
                result.message
            );

            return;
        }

    });

    // --------------------------------------------------
    // NEW GAME
    // --------------------------------------------------

    socket.on("newGame", () => {

        calledNumbers = [];

        gameStarted = true;

        console.log("NEW GAME");

        io.emit("newGameStarted", {

            gameStarted: true,

            calledNumbers: [],

            totalCalled: 0

        });

    });

    // --------------------------------------------------
    // STOP GAME
    // --------------------------------------------------

    socket.on("stopGame", () => {

        gameStarted = false;

        console.log("GAME STOPPED");

        io.emit("gameStopped", {

            gameStarted: false

        });

    });

    // --------------------------------------------------
    // DISCONNECT
    // --------------------------------------------------

    socket.on("disconnect", () => {

        console.log(
            "Player disconnected:",
            socket.id
        );

    });

});

// ======================================================
// TELEGRAM API
// ======================================================

async function telegramRequest(method, data = {}) {

    if (!TELEGRAM_BOT_TOKEN) {
        throw new Error(
            "TELEGRAM_BOT_TOKEN is missing."
        );
    }

    const url =
        `https://api.telegram.org/bot${TELEGRAM_BOT_TOKEN}/${method}`;

    const response = await fetch(url, {

        method: "POST",

        headers: {
            "Content-Type": "application/json"
        },

        body: JSON.stringify(data)

    });

    const result = await response.json();

    if (!result.ok) {

        throw new Error(
            result.description || "Telegram API error"
        );

    }

    return result.result;
}

// ======================================================
// SEND TELEGRAM MESSAGE
// ======================================================

async function sendTelegramMessage(chatId, text) {

    try {

        await telegramRequest(
            "sendMessage",
            {
                chat_id: chatId,
                text: text
            }
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

// ======================================================
// TELEGRAM /START
// ======================================================

async function handleTelegramStart(chatId) {

    const message =

`🎱 EDILBINGO

Welcome to EDILBINGO!

Commands:

🎮 /newgame
Start a new Bingo game

🔔 /draw
Draw the next number

📊 /status
Show game status

🛑 /stop
Stop the game

🌐 Website:
http://localhost:${PORT}`;

    await sendTelegramMessage(
        chatId,
        message
    );

}

// ======================================================
// TELEGRAM /NEWGAME
// ======================================================

async function handleTelegramNewGame(chatId) {

    calledNumbers = [];

    gameStarted = true;

    console.log(
        "NEW GAME STARTED FROM TELEGRAM"
    );

    io.emit("newGameStarted", {

        gameStarted: true,

        calledNumbers: [],

        totalCalled: 0

    });

    await sendTelegramMessage(
        chatId,
`🎱 EDILBINGO

🟢 NEW GAME STARTED!

All 75 numbers are available.

Use /draw to draw the first number.`
    );

}

// ======================================================
// TELEGRAM /DRAW
// ======================================================

async function handleTelegramDraw(chatId) {

    const result = performDraw();

    if (!result.success) {

        await sendTelegramMessage(
            chatId,
            `⚠️ ${result.message}`
        );

        return;
    }

    const remaining =
        75 - result.totalCalled;

    const message =

`🎱 EDILBINGO

🔔 NUMBER DRAWN
━━━━━━━━━━━━━━
        ${result.display}
━━━━━━━━━━━━━━

📊 Called: ${result.totalCalled} / 75
🔢 Remaining: ${remaining}

Good luck! 🍀`;

    await sendTelegramMessage(
        chatId,
        message
    );

}

// ======================================================
// TELEGRAM /STATUS
// ======================================================

async function handleTelegramStatus(chatId) {

    let numbersText;

    if (calledNumbers.length === 0) {

        numbersText = "None";

    } else {

        numbersText = calledNumbers
            .map(number => {
                return `${getLetter(number)}-${number}`;
            })
            .join(", ");

    }

    const message =

`🎱 EDILBINGO STATUS

Game: ${gameStarted ? "🟢 RUNNING" : "🔴 STOPPED"}

📊 Called:
${calledNumbers.length} / 75

🔢 Remaining:
${75 - calledNumbers.length}

📋 Numbers:
${numbersText}`;

    await sendTelegramMessage(
        chatId,
        message
    );

}

// ======================================================
// TELEGRAM /STOP
// ======================================================

async function handleTelegramStop(chatId) {

    gameStarted = false;

    console.log(
        "GAME STOPPED FROM TELEGRAM"
    );

    io.emit("gameStopped", {

        gameStarted: false

    });

    await sendTelegramMessage(
        chatId,
`🎱 EDILBINGO

🔴 GAME STOPPED

Use /newgame to start a new game.`
    );

}

// ======================================================
// PROCESS TELEGRAM MESSAGE
// ======================================================

async function processTelegramMessage(message) {

    if (!message || !message.chat) {
        return;
    }

    const chatId = message.chat.id;

    const text =
        (message.text || "").trim();

    if (!text) {
        return;
    }

    console.log(
        `Telegram message from ${chatId}: ${text}`
    );

    // Remove @BotName from group commands
    const command =
        text
            .split(" ")[0]
            .split("@")[0]
            .toLowerCase();

    try {

        switch (command) {

            case "/start":

                await handleTelegramStart(
                    chatId
                );

                break;

            case "/newgame":

                await handleTelegramNewGame(
                    chatId
                );

                break;

            case "/draw":

                await handleTelegramDraw(
                    chatId
                );

                break;

            case "/status":

                await handleTelegramStatus(
                    chatId
                );

                break;

            case "/stop":

                await handleTelegramStop(
                    chatId
                );

                break;

            default:

                await sendTelegramMessage(
                    chatId,
`🎱 EDILBINGO

I don't understand that command.

Available commands:

/start
/newgame
/draw
/status
/stop`
                );

        }

    } catch (error) {

        console.error(
            "Telegram command error:",
            error.message
        );

    }

}

// ======================================================
// TELEGRAM LONG POLLING
// ======================================================

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
            await telegramRequest("getMe");

        console.log(
            `Telegram bot connected: @${me.username}`
        );

    } catch (error) {

        console.error(
            "Telegram bot connection failed:",
            error.message
        );

        return;
    }

    while (true) {

        try {

            const updates =
                await telegramRequest(
                    "getUpdates",
                    {
                        offset: telegramOffset,
                        timeout: 30
                    }
                );

            for (const update of updates) {

                telegramOffset =
                    update.update_id + 1;

                if (update.message) {

                    await processTelegramMessage(
                        update.message
                    );

                }

            }

        } catch (error) {

            console.error(
                "Telegram polling error:",
                error.message
            );

            await new Promise(
                resolve => setTimeout(
                    resolve,
                    5000
                )
            );

        }

    }

}

// ======================================================
// START SERVER
// ======================================================

server.listen(PORT, () => {

    console.log(
        `EDILBINGO server running at http://localhost:${PORT}`
    );

    startTelegramBot();

});