/**
 * Safe Study VC Tracker Bot with To-Do & Daily Goals
 *
 * Commands:
 *  - /settarget minutes
 *  - /cleartarget
 *  - /addtodo task
 *  - /listtodos
 *  - /donetodo id
 *  - /deltodo id
 *  - /setgoal hours
 *
 * Behavior:
 *  - Tracks VC time.
 *  - Congratulates user if target is reached.
 *  - Kicks user if they leave VC early.
 *  - Tracks user's personal To-Do list.
 *  - Tracks daily goal and resets every day at midnight.
 *  - Users failing daily goal or incomplete todos get kicked with reason.
 */

const {
  Client,
  GatewayIntentBits,
  Partials,
  REST,
  Routes,
  SlashCommandBuilder,
  PermissionFlagsBits,
} = require("discord.js");
const { configDotenv } = require("dotenv");
configDotenv();
const sqlite3 = require("sqlite3").verbose();
const path = require("path");
const schedule = require("node-schedule");

// ---------- CONFIG ----------
const BOT_TOKEN = process.env.DISCORD_TOKEN;
if (!BOT_TOKEN) {
  console.error("Please set DISCORD_TOKEN environment variable.");
  process.exit(1);
}

const DATA_FILE = path.resolve(__dirname, "vc_tracker.db");
const CHECK_INTERVAL_MS = 10_000; // 10 seconds
// ----------------------------

const client = new Client({
  intents: [GatewayIntentBits.Guilds, GatewayIntentBits.GuildVoiceStates],
  partials: [Partials.Channel],
});

// Setup SQLite database
const db = new sqlite3.Database(DATA_FILE);
db.serialize(() => {
  db.run(`
    CREATE TABLE IF NOT EXISTS targets (
      guild_id TEXT NOT NULL,
      user_id TEXT NOT NULL,
      target_seconds INTEGER NOT NULL,
      accumulated_seconds INTEGER NOT NULL DEFAULT 0,
      session_start INTEGER NULL,
      PRIMARY KEY(guild_id, user_id)
    )
  `);

  db.run(`
    CREATE TABLE IF NOT EXISTS todos (
      guild_id TEXT NOT NULL,
      user_id TEXT NOT NULL,
      task_id INTEGER PRIMARY KEY AUTOINCREMENT,
      task TEXT NOT NULL,
      completed INTEGER NOT NULL DEFAULT 0
    )
  `);

  db.run(`
    CREATE TABLE IF NOT EXISTS daily_goals (
      guild_id TEXT NOT NULL,
      user_id TEXT NOT NULL,
      goal_hours REAL NOT NULL,
      achieved_hours REAL NOT NULL DEFAULT 0,
      session_start INTEGER NULL,
      PRIMARY KEY(guild_id, user_id)
    )
  `);
});

// ----- VC Tracker Helpers -----
function setTarget(guildId, userId, seconds) {
  return new Promise((resolve, reject) => {
    db.run(
      `
      INSERT INTO targets (guild_id, user_id, target_seconds, accumulated_seconds, session_start)
      VALUES (?, ?, ?, 0, NULL)
      ON CONFLICT(guild_id, user_id) DO UPDATE 
        SET target_seconds = excluded.target_seconds, accumulated_seconds = 0, session_start = NULL
      `,
      [guildId, userId, seconds],
      (err) => (err ? reject(err) : resolve())
    );
  });
}

function clearTarget(guildId, userId) {
  return new Promise((resolve, reject) => {
    db.run(
      `DELETE FROM targets WHERE guild_id = ? AND user_id = ?`,
      [guildId, userId],
      (err) => (err ? reject(err) : resolve())
    );
  });
}

function getTarget(guildId, userId) {
  return new Promise((resolve, reject) => {
    db.get(
      `SELECT * FROM targets WHERE guild_id = ? AND user_id = ?`,
      [guildId, userId],
      (err, row) => (err ? reject(err) : resolve(row || null))
    );
  });
}

function setSessionStart(guildId, userId, ts) {
  return new Promise((resolve, reject) => {
    db.run(
      `UPDATE targets SET session_start = ? WHERE guild_id = ? AND user_id = ?`,
      [ts, guildId, userId],
      (err) => (err ? reject(err) : resolve())
    );
  });
}

function addAccumulated(guildId, userId, addSeconds) {
  return new Promise((resolve, reject) => {
    db.run(
      `UPDATE targets SET accumulated_seconds = accumulated_seconds + ?, session_start = NULL WHERE guild_id = ? AND user_id = ?`,
      [addSeconds, guildId, userId],
      (err) => (err ? reject(err) : resolve())
    );
  });
}

function getAllActiveSessions() {
  return new Promise((resolve, reject) => {
    db.all(
      `SELECT * FROM targets WHERE session_start IS NOT NULL`,
      [],
      (err, rows) => (err ? reject(err) : resolve(rows || []))
    );
  });
}

// ----- To-Do Helpers -----
function addTodo(guildId, userId, task) {
  return new Promise((resolve, reject) => {
    db.run(
      `INSERT INTO todos (guild_id, user_id, task, completed) VALUES (?, ?, ?, 0)`,
      [guildId, userId, task],
      (err) => (err ? reject(err) : resolve())
    );
  });
}

function getTodos(guildId, userId) {
  return new Promise((resolve, reject) => {
    db.all(
      `SELECT * FROM todos WHERE guild_id = ? AND user_id = ?`,
      [guildId, userId],
      (err, rows) => (err ? reject(err) : resolve(rows || []))
    );
  });
}

function completeTodo(guildId, userId, taskId) {
  return new Promise((resolve, reject) => {
    db.run(
      `UPDATE todos SET completed = 1 WHERE guild_id = ? AND user_id = ? AND task_id = ?`,
      [guildId, userId, taskId],
      (err) => (err ? reject(err) : resolve())
    );
  });
}

function deleteTodo(guildId, userId, taskId) {
  return new Promise((resolve, reject) => {
    db.run(
      `DELETE FROM todos WHERE guild_id = ? AND user_id = ? AND task_id = ?`,
      [guildId, userId, taskId],
      (err) => (err ? reject(err) : resolve())
    );
  });
}

// ----- Daily Goal Helpers -----
function setDailyGoal(guildId, userId, hours) {
  return new Promise((resolve, reject) => {
    db.run(
      `INSERT INTO daily_goals (guild_id, user_id, goal_hours, achieved_hours, session_start)
       VALUES (?, ?, ?, 0, NULL)
       ON CONFLICT(guild_id, user_id) DO UPDATE
       SET goal_hours = excluded.goal_hours, achieved_hours = 0, session_start = NULL`,
      [guildId, userId, hours],
      (err) => (err ? reject(err) : resolve())
    );
  });
}

function getDailyGoal(guildId, userId) {
  return new Promise((resolve, reject) => {
    db.get(
      `SELECT * FROM daily_goals WHERE guild_id = ? AND user_id = ?`,
      [guildId, userId],
      (err, row) => (err ? reject(err) : resolve(row || null))
    );
  });
}

function addAchievedHours(guildId, userId, addHours) {
  return new Promise((resolve, reject) => {
    db.run(
      `UPDATE daily_goals SET achieved_hours = achieved_hours + ? WHERE guild_id = ? AND user_id = ?`,
      [addHours, guildId, userId],
      (err) => (err ? reject(err) : resolve())
    );
  });
}

function getAllDailyGoals() {
  return new Promise((resolve, reject) => {
    db.all(`SELECT * FROM daily_goals`, [], (err, rows) => (err ? reject(err) : resolve(rows || [])));
  });
}

function clearDailyGoals() {
  return new Promise((resolve, reject) => {
    db.run(`DELETE FROM daily_goals`, (err) => (err ? reject(err) : resolve()));
  });
}

// ----- Register Commands -----
async function registerCommands() {
  const commands = [
    new SlashCommandBuilder()
      .setName("settarget")
      .setDescription("Set your study target in minutes")
      .addNumberOption((opt) => opt.setName("minutes").setDescription("Minutes").setRequired(true)),

    new SlashCommandBuilder()
      .setName("cleartarget")
      .setDescription("Clear your study target"),

    new SlashCommandBuilder()
      .setName("addtodo")
      .setDescription("Add a new task")
      .addStringOption((opt) => opt.setName("task").setDescription("Task text").setRequired(true)),

    new SlashCommandBuilder()
      .setName("listtodos")
      .setDescription("List your tasks"),

    new SlashCommandBuilder()
      .setName("donetodo")
      .setDescription("Mark a task as done")
      .addIntegerOption((opt) => opt.setName("id").setDescription("Task ID").setRequired(true)),

    new SlashCommandBuilder()
      .setName("deltodo")
      .setDescription("Delete a task")
      .addIntegerOption((opt) => opt.setName("id").setDescription("Task ID").setRequired(true)),

    new SlashCommandBuilder()
      .setName("setgoal")
      .setDescription("Set your daily goal in hours")
      .addNumberOption((opt) => opt.setName("hours").setDescription("Goal in hours").setRequired(true)),

  ].map((c) => c.toJSON());

  const rest = new REST({ version: "10" }).setToken(BOT_TOKEN);
  const GUILD_ID = process.env.GUILD_ID; // replace with your guild ID
  await rest.put(Routes.applicationGuildCommands(client.user.id, GUILD_ID), { body: commands });
}

// ----- Ready -----
client.once("ready", async () => {
  console.log(`Logged in as ${client.user.tag}`);
  await registerCommands();
  console.log("Commands registered");

  // Periodic check for VC
  setInterval(async () => {
    const now = Date.now();
    try {
      const sessions = await getAllActiveSessions();
      for (const s of sessions) {
        const elapsed = Math.floor((now - s.session_start) / 1000);
        const total = s.accumulated_seconds + elapsed;

        // Add to daily goal if exists
        const dailyGoal = await getDailyGoal(s.guild_id, s.user_id);
        if (dailyGoal) await addAchievedHours(s.guild_id, s.user_id, elapsed / 3600);

        if (total >= s.target_seconds) {
          const guild = client.guilds.cache.get(s.guild_id);
          if (!guild) continue;
          const member = await guild.members.fetch(s.user_id).catch(() => null);
          if (member) {
            const hours = (s.target_seconds / 3600).toFixed(2);
            member.send(`🎉 Congrats! You reached your study target of ${hours} hours!`).catch(() => {});
          }
          await clearTarget(s.guild_id, s.user_id);
        }
      }
    } catch (err) {
      console.error(err);
    }
  }, CHECK_INTERVAL_MS);

  // Daily reset at 12:00 AM
  schedule.scheduleJob({rule:"0 0 * * *",tz: "Asia/Kathmandu"}, async () => {
    try {
      const goals = await getAllDailyGoals();
      for (const g of goals) {
        if (g.achieved_hours < g.goal_hours) {
          const guild = client.guilds.cache.get(g.guild_id);
          if (!guild) continue;
          const member = await guild.members.fetch(g.user_id).catch(() => null);
          if (member) {
            await member.kick(`Did not complete daily goal (${g.achieved_hours.toFixed(2)}/${g.goal_hours} hours)`).catch(() => {});
            await member.send(`You were kicked from ${guild.name} for not completing your daily goal (${g.achieved_hours.toFixed(2)}/${g.goal_hours} hours).`).catch(() => {});
          }
        }
      }

      // Reset daily goals and todos
      await clearDailyGoals();
      db.run(`DELETE FROM todos`, () => {});
      console.log("Daily reset complete.");
    } catch (err) {
      console.error("Error during daily reset:", err);
    }
  });
});

// ----- Voice State Update -----
client.on("voiceStateUpdate", async (oldState, newState) => {
  if (newState.member.user.bot) return;

  const guildId = newState.guild.id;
  const userId = newState.id;
  const row = await getTarget(guildId, userId);
  if (!row) return;

  if (!oldState.channelId && newState.channelId) {
    await setSessionStart(guildId, userId, Date.now());
  }

  if (oldState.channelId && !newState.channelId) {
    let elapsed = 0;
    if (row.session_start) elapsed = Math.floor((Date.now() - row.session_start) / 1000);
    await addAccumulated(guildId, userId, elapsed);

    // Add to daily goal if exists
    const dailyGoal = await getDailyGoal(guildId, userId);
    if (dailyGoal) await addAchievedHours(guildId, userId, elapsed / 3600);

    const updated = await getTarget(guildId, userId);
    if (!updated) return;

    if (updated.accumulated_seconds >= updated.target_seconds) {
      const member = await newState.guild.members.fetch(userId).catch(() => null);
      if (member) member.send("🎉 Congrats! You reached your study target!").catch(() => {});
      await clearTarget(guildId, userId);
    } else {
      try {
        const member = await newState.guild.members.fetch(userId).catch(() => null);
        if (!member) return;

        const botMember = newState.guild.members.me;
        if (!botMember.permissions.has(PermissionFlagsBits.KickMembers)) {
          const announceChannel = newState.guild.systemChannel ?? newState.guild.channels.cache.find(c => c.isTextBased() && c.permissionsFor(botMember).has("SendMessages"));
          if (announceChannel) announceChannel.send(`<@${userId}> left VC early but I don't have permission to kick.`).catch(() => {});
          return;
        }

        if (member.roles.highest.position >= botMember.roles.highest.position) {
          await member.send("⚠️ You left VC early, but I couldn't kick you due to role hierarchy.").catch(() => {});
          return;
        }

        await member.kick(`Left VC before reaching study target (${(updated.accumulated_seconds / 3600).toFixed(2)} / ${(updated.target_seconds / 3600).toFixed(2)} hours)`);
        await member.send(`You were kicked for leaving VC early (${(updated.accumulated_seconds / 3600).toFixed(2)} / ${(updated.target_seconds / 3600).toFixed(2)} hours)`).catch(() => {});
        await clearTarget(guildId, userId);

      } catch (err) {
        console.error("Failed to kick user:", err);
      }
    }
  }
});

// ----- Slash Commands -----
client.on("interactionCreate", async (interaction) => {
  if (!interaction.isChatInputCommand()) return;
  const { commandName, guild, user } = interaction;
  if (!guild) return interaction.reply({ content: "This bot works only in servers.", ephemeral: true });

  // VC Commands
  if (commandName === "settarget") {
    const minutes = interaction.options.getNumber("minutes", true);
    if (minutes <= 0) return interaction.reply({ content: "Provide a positive number of minutes.", ephemeral: true });
    await setTarget(guild.id, user.id, Math.floor(minutes * 60));
    return interaction.reply({ content: `Target set: ${minutes} minutes. Join a VC to start tracking.`, ephemeral: false });
  }

  if (commandName === "cleartarget") {
    await clearTarget(guild.id, user.id);
    return interaction.reply({ content: "Your target has been cleared.", ephemeral: true });
  }

  // To-Do Commands
  if (commandName === "addtodo") {
    const task = interaction.options.getString("task", true);
    await addTodo(guild.id, user.id, task);
    return interaction.reply({ content: `✅ Task added: ${task}`, ephemeral: true });
  }

  if (commandName === "listtodos") {
    const todos = await getTodos(guild.id, user.id);
    if (todos.length === 0) return interaction.reply({ content: "No tasks found!", ephemeral: true });
    const lines = todos.map(t => `${t.task_id}. [${t.completed ? "✅" : "❌"}] ${t.task}`);
    return interaction.reply({ content: lines.join("\n"), ephemeral: true });
  }

  if (commandName === "donetodo") {
    const id = interaction.options.getInteger("id", true);
    await completeTodo(guild.id, user.id, id);
    return interaction.reply({ content: `✅ Task ${id} marked done.`, ephemeral: true });
  }

  if (commandName === "deltodo") {
    const id = interaction.options.getInteger("id", true);
    await deleteTodo(guild.id, user.id, id);
    return interaction.reply({ content: `🗑 Task ${id} deleted.`, ephemeral: true });
  }

  // Daily Goal Command
  if (commandName === "setgoal") {
    const hours = interaction.options.getNumber("hours", true);
    if (hours <= 0) return interaction.reply({ content: "Provide a positive number of hours.", ephemeral: true });
    await setDailyGoal(guild.id, user.id, hours);
    return interaction.reply({ content: `✅ Daily goal set: ${hours} hour(s)`, ephemeral: true });
  }
});

// ----- Login -----
client.login(BOT_TOKEN);

