import Sequelize from 'sequelize';
import DiscordBasePlugin from './discord-base-plugin.js';
import { setTimeout as delay } from "timers/promises";
const { DataTypes, Op } = Sequelize;

export default class Switch extends DiscordBasePlugin {
    static get description() {
        return "Team-change management with cooldown enforcement, database persistence, and admin controls.";
    }

    static get defaultEnabled() {
        return true;
    }

    static get optionsSpecification() {
        return {
            discordClient: {
                required: true,
                description: 'Discord connector name.',
                connector: 'discord',
                default: 'discord'
            },
            commandPrefix: {
                required: false,
                description: "Prefix of every switch command, can be an array",
                default: [ "!switch", "!change" ]
            },
            doubleSwitchCommands: {
                required: false,
                description: 'Array of commands that can be sent in every chat to request a double switch',
                default: [],
                example: [ '!bug', '!stuck', '!doubleswitch' ]
            },
            doubleSwitchCooldownHours: {
                required: false,
                description: "Hours to wait before using again one of the double switch commands",
                default: 0.5
            },
            doubleSwitchDelaySeconds: {
                required: false,
                description: "Delay between the first and second team switch",
                default: 1
            },
            switchCooldownHours: {
                required: false,
                description: "Hours to wait before using again the !switch command",
                default: 3
            },
            switchCooldownMinutes: {
                required: false,
                description: "Minutes to wait before using again the !switch command (overrides hours if set)",
                default: 0
            },
            switchEnabledMinutes: {
                required: false,
                description: "Time in minutes in which the switch will be enabled after match start or player join. Set to 0 to disable this time restriction entirely.",
                default: 0
            },
            doubleSwitchEnabledMinutes: {
                required: false,
                description: "Time in minutes in which a double switch will be enabled after match start or player join. Set to 0 to disable this time restriction entirely.",
                default: 0
            },
            maxUnbalancedSlots: {
                required: false,
                description: "Number of player of difference between the two teams to allow a team switch",
                default: 3
            },
            switchToOldTeamAfterRejoin: {
                required: false,
                description: "The team of a disconnecting player will be stored and after a new connection, the player will be switched to his old team",
                default: false
            },
            discordChannelID: {
                required: false,
                description: "Discord channel ID for logs.",
                default: ''
            },
            database: {
                required: true,
                connector: 'sequelize',
                description: 'The Sequelize connector to log server information to.',
                default: 'sqlite'
            },
            scrambleLockdownEnabled: {
                required: false,
                description: "Whether TEAM_BALANCER_SCRAMBLE_EXECUTED triggers a switch lockdown. This listener is a no-op unless some other plugin actually emits that event; this option exists for devs who run their own scramble-emitting plugin but don't want it to lock out switching.",
                default: true,
                type: 'boolean'
            },
            scrambleLockdownDurationMinutes: {
                required: false,
                description: "Duration in minutes to block switching after a scramble.",
                default: 20
            },
            liberalSwitchGameModes: {
                required: false,
                description: "Substrings for layer/gamemode names where switching rules are relaxed (no time/cooldown limits).",
                default: ['Seed', 'Jensen'],
                type: 'array'
            },
            liberalSwitchMaxUnbalancedSlots: {
                required: false,
                description: "Balance cap during liberal modes (e.g., Seed/Jensen). Allows more permissive switching up to a ceiling of 50v50.",
                default: 6,
                type: 'number'
            },
            dynamicBalanceTolerance: {
                required: false,
                description: "Enable interpolated extra imbalance tolerance when server is below full capacity (default: off). Scales from floor to 98 players.",
                default: false,
                type: 'boolean'
            },
            dynamicBalancePlayerFloor: {
                required: false,
                description: "Total player count at which maximum extra tolerance kicks in (default 90). Below this, full extra slots apply.",
                default: 90,
                type: 'number'
            },
            dynamicBalanceExtraSlots: {
                required: false,
                description: "Additional allowed imbalance slots at the floor player count (default 2). Linearly interpolated between floor and 98 players.",
                default: 2,
                type: 'number'
            }
        };
    }

    constructor(server, options, connectors) {
        super(server, options, connectors);

        this.onChatMessage = this.onChatMessage.bind(this);
        this.onPlayerConnected = this.onPlayerConnected.bind(this);
        this.onUpdatedPlayerInfo = this.onUpdatedPlayerInfo.bind(this);
        this.switchPlayer = this.switchPlayer.bind(this);
        this.getPlayersByUsername = this.getPlayersByUsername.bind(this);
        this.getPlayerBySteamID = this.getPlayerBySteamID.bind(this);
        this.getPlayerByUsernameOrEosID = this.getPlayerByUsernameOrEosID.bind(this);
        this.getPlayerByEosID = this.getPlayerByEosID.bind(this);
        this.doubleSwitchPlayer = this.doubleSwitchPlayer.bind(this);
        this.getFactionId = this.getFactionId.bind(this);
        this.switchSquad = this.switchSquad.bind(this);
        this.getSecondsFromJoin = this.getSecondsFromJoin.bind(this);
        this.getSecondsFromMatchStart = this.getSecondsFromMatchStart.bind(this);
        this.getTeamBalanceDifference = this.getTeamBalanceDifference.bind(this);
        this.switchToPreDisconnectionTeam = this.switchToPreDisconnectionTeam.bind(this);
        this.getSwitchSlotsPerTeam = this.getSwitchSlotsPerTeam.bind(this);
        this.onRoundEnded = this.onRoundEnded.bind(this);
        this.addPlayerToMatchendSwitches = this.addPlayerToMatchendSwitches.bind(this);
        this.doSwitchMatchend = this.doSwitchMatchend.bind(this);
        this.cleanup = this.cleanup.bind(this);
        this.onScrambleExecuted = this.onScrambleExecuted.bind(this);
        this.checkPlayer = this.checkPlayer.bind(this);
        this.onDiscordMessage = this.onDiscordMessage.bind(this);
        this.getDiagnosticInfo = this.getDiagnosticInfo.bind(this);
        this.safeTransaction = this.safeTransaction.bind(this);
        this.safeDiscordReply = this.safeDiscordReply.bind(this);
        this.onNewGame = this.onNewGame.bind(this);
        this.onUpdatedLayerInfo = this.onUpdatedLayerInfo.bind(this);
        this.onServerInfoUpdated = this.onServerInfoUpdated.bind(this);

        // Map<eosID, timestamp_ms> — tracks when each player first appeared (in-memory cache)
        this.playersConnectionTime = {};
        // Array<{eosID, datetime}> — tracks double-switch usage for cooldown enforcement
        this.recentDoubleSwitches = [];
        // Object<eosID, {teamID, time}> — stores disconnection data for rejoin-to-old-team feature (20min retention)
        this.recentDisconnections = {};
        // Map<eosID, {teamID, name}> — authoritative in-memory player roster, synced via UPDATED_PLAYER_INFORMATION delta-diff
        this._knownConnectedPlayers = new Map();
        // Set<eosID> — tracks which players have already been processed for switchToPreDisconnectionTeam (prevents double-fire)
        this._switchedOnJoin = new Set();
        // Layer tracking for liberal mode detection
        this.currentLayerName = null;
        this.currentGamemode = null;
        this._liberalModes = [];

        this.models = {};

        this.createModel('Endmatch', {
            id: {
                type: DataTypes.INTEGER,
                primaryKey: true,
                autoIncrement: true
            },
            name: {
                type: DataTypes.STRING
            },
            steamID: {
                type: DataTypes.STRING
            },
            eosID: {
                type: DataTypes.STRING
            },
            created_at: {
                type: DataTypes.DATE,
                defaultValue: DataTypes.NOW
            }
        });

        this.createModel('PlayerCooldowns', {
            eosID: {
                type: DataTypes.STRING,
                primaryKey: true,
                allowNull: false
            },
            steamID: {
                type: DataTypes.STRING,
                allowNull: true
            },
            playerName: {
                type: DataTypes.STRING,
                allowNull: true
            },
            lastSwitchTimestamp: {
                type: DataTypes.DATE,
                allowNull: true
            },
            firstSeenTimestamp: {
                type: DataTypes.DATE,
                allowNull: true
            },
            scrambleLockdownExpiry: {
                type: DataTypes.DATE,
                allowNull: true
            }
        });

        this.broadcast = (msg) => { this.server.rcon.broadcast(msg); };
        this.warn = (eosID, msg) => {
            const player = this.getPlayerByEosID(eosID);
            if (player) {
                this.server.rcon.warn(player.name, msg);
            } else {
                this.verbose(1, `[warn] Player with eosID ${eosID} not found, cannot send: ${msg}`);
            }
        };
    }

    /**
     * Wraps a Sequelize transaction with retry logic for SQLite locking.
     * SQLite can throw SQLITE_BUSY under concurrent write load; this retries up to 5 times
     * with randomized backoff (200–700ms) before propagating the error.
     * @param {Function} logicFn - Async function receiving a transaction object (t).
     * @returns {Promise<any>} The return value of logicFn.
     */
    async safeTransaction(logicFn) {
        const maxRetries = 5;
        for (let i = 0; i < maxRetries; i++) {
            try {
                return await this.options.database.transaction(logicFn);
            } catch (err) {
                const isLocked = err.message && (
                    err.message.includes('SQLITE_BUSY') ||
                    err.message.includes('database is locked') ||
                    err.name === 'SequelizeTimeoutError'
                );
                if (isLocked && i < maxRetries - 1) {
                    await delay(Math.random() * 500 + 200);
                } else {
                    throw err;
                }
            }
        }
    }

    async safeDiscordReply(message, content) {
        if (!message || !content) return;
        try {
            await message.reply(content);
        } catch (err) {
            this.verbose(1, `Discord reply failed: ${err.message}`);
        }
    }

    async mount() {
        await this.models.PlayerCooldowns.sync({ alter: true });

        // Initialize liberal mode substring list (lowercased for comparison)
        this._liberalModes = (this.options.liberalSwitchGameModes || ['Seed', 'Jensen']).map(m => String(m).toLowerCase());

        // Bootstrap layer info from server state at mount time
        if (this.server.currentLayer?.name) {
            this.currentLayerName = this.server.currentLayer.name;
            this.currentGamemode = this.server.currentLayer.gamemode || null;
            this.verbose(1, `[Layer] Bootstrapped from server.currentLayer at mount: ${this.currentLayerName} (${this.currentGamemode})`);
        }

        this.server.on('CHAT_MESSAGE', this.onChatMessage);
        this.server.on('PLAYER_CONNECTED', this.onPlayerConnected);
        this.server.on('UPDATED_PLAYER_INFORMATION', this.onUpdatedPlayerInfo);
        this.server.on('ROUND_ENDED', this.onRoundEnded)
        this.server.on('TEAM_BALANCER_SCRAMBLE_EXECUTED', this.onScrambleExecuted);
        this.server.on('NEW_GAME', this.onNewGame);
        this.server.on('UPDATED_LAYER_INFORMATION', this.onUpdatedLayerInfo);
        this.server.on('UPDATED_SERVER_INFORMATION', this.onServerInfoUpdated);
        if (this.options.discordClient) {
            this.options.discordClient.on('message', this.onDiscordMessage);
        }
    }

    async prepareToMount() {
        if (this.options.discordChannelID) {
            this.options.channelID = this.options.discordChannelID;
        }
        await super.prepareToMount();
        await this.models.Endmatch.sync();
        await this.models.PlayerCooldowns.sync({ alter: true });
    }

    createModel(name, schema) {
        this.models[ name ] = this.options.database.define(`SwitchPlugin_${name}`, schema, {
            timestamps: false
        });
    }

    async onChatMessage(info) {
        try {
            const steamID = info.player?.steamID;
            const eosID = info.player?.eosID;
            const playerName = info.player?.name;
            const teamID = info.player?.teamID;
            const message = info.message.toLowerCase();

            if (this.options.doubleSwitchCommands.find(c => c.toLowerCase() == message)) {
                const dsEosID = info.player?.eosID;
                if (!dsEosID) {
                    this.verbose(1, `[doubleSwitchCommands] Missing eosID for player ${info.player?.name}, skipping double switch`);
                    return;
                }
                this.doubleSwitchPlayer(dsEosID);
            }

            const commandPrefixInUse = typeof this.options.commandPrefix === 'string' ? this.options.commandPrefix : this.options.commandPrefix.find(c => message.startsWith(c.toLowerCase()));

            if ((typeof this.options.commandPrefix === 'string' && !message.startsWith(this.options.commandPrefix)) || (typeof this.options.commandPrefix === 'object' && this.options.commandPrefix.length >= 1 && !this.options.commandPrefix.find(c => message.startsWith(c.toLowerCase())))) return;

            const connectionSeconds = await this.getSecondsFromJoin(info.player?.eosID);
            const connectionLog = connectionSeconds > 0 ? `${connectionSeconds.toFixed(1)}s` : "0s (New Join/Plugin Reload)";
            this.verbose(1, `${playerName}:\n > Connection: ${connectionLog}\n > Match Start: ${this.getSecondsFromMatchStart().toFixed(1)}s`);
            this.verbose(1, `[Command] Player ${playerName} sent: ${info.message}`);

            const commandSplit = message.substring(commandPrefixInUse.length).trim().split(' ').filter(Boolean);
            const subCommand = commandSplit[ 0 ];

            const isAdmin = info.chat === "ChatAdmin" || (this.server.admins && steamID && Object.prototype.hasOwnProperty.call(this.server.admins, steamID));
            if (subCommand && subCommand != '') {
                let pl;
                switch (subCommand) {
                case 'now':
                    if (!isAdmin) {
                        this.verbose(1, `[Denied] Player ${playerName} (not admin) attempted admin command: ${subCommand}`);
                        return;
                    }
                    this.verbose(1, `[Admin] Command '${subCommand}' accepted from ${playerName}`);
                    pl = this.getPlayerByUsernameOrEosID(eosID, commandSplit.splice(1).join(' '))
                    if (pl) {
                        this.switchPlayer(pl.eosID)?.catch(err => {
                            this.verbose(1, `Admin switch now failed: ${err.message}`);
                        });
                    }
                    break;
                case 'double':
                    if (!isAdmin) {
                        this.verbose(1, `[Denied] Player ${playerName} (not admin) attempted admin command: ${subCommand}`);
                        return;
                    }
                    this.verbose(1, `[Admin] Command '${subCommand}' accepted from ${playerName}`);
                    pl = this.getPlayerByUsernameOrEosID(eosID, commandSplit.splice(1).join(' '))
                    if (pl) {
                        await this.doubleSwitchPlayer(pl.eosID, true);
                    }
                    break;
                case 'squad':
                    if (!isAdmin) {
                        this.verbose(1, `[Denied] Player ${playerName} (not admin) attempted admin command: ${subCommand}`);
                        return;
                    }
                    this.verbose(1, `[Admin] Command '${subCommand}' accepted from ${playerName}`);
                    await this.server.updateSquadList();
                    await this.server.updatePlayerList();
                    await this.switchSquad(+commandSplit[ 1 ], commandSplit[ 2 ]);
                    break;
                case 'refresh':
                    await this.server.updateSquadList();
                    await this.server.updatePlayerList();
                    this.warn(eosID, `Players and squads refreshed.`);
                    break;
                case 'slots':
                    await this.server.updateSquadList();
                    await this.server.updatePlayerList();
                    this.warn(eosID, `Switch Slots:\nTeam 1: ${this.getSwitchSlotsPerTeam(1)}\nTeam 2: ${this.getSwitchSlotsPerTeam(2)}`);
                    break;
                case "matchend":
                    if (!isAdmin) {
                        this.verbose(1, `[Denied] Player ${playerName} (not admin) attempted admin command: ${subCommand}`);
                        return;
                    }
                    this.verbose(1, `[Admin] Command '${subCommand}' accepted from ${playerName}`);
                    await this.server.updatePlayerList();
                    pl = this.getPlayerByUsernameOrEosID(eosID, commandSplit.splice(1).join(' '));
                    if (!pl) return;
                    {
                        const scheduled = await this.addPlayerToMatchendSwitches(pl);
                        this.warn(eosID, scheduled
                            ? `Player "${pl.name}" scheduled for switch at match end.`
                            : `Player "${pl.name}" is already scheduled for switch at match end.`);
                    }
                    break;
                case "doublesquad":
                    if (!isAdmin) {
                        this.verbose(1, `[Denied] Player ${playerName} (not admin) attempted admin command: ${subCommand}`);
                        return;
                    }
                    this.verbose(1, `[Admin] Command '${subCommand}' accepted from ${playerName}`);
                    await this.server.updateSquadList();
                    await this.server.updatePlayerList();
                    await this.doubleSwitchSquad(+commandSplit[ 1 ], commandSplit[ 2 ]);
                    break;
                case "matchendsquad":
                    if (!isAdmin) {
                        this.verbose(1, `[Denied] Player ${playerName} (not admin) attempted admin command: ${subCommand}`);
                        return;
                    }
                    this.verbose(1, `[Admin] Command '${subCommand}' accepted from ${playerName}`);
                    await this.server.updateSquadList();
                    await this.server.updatePlayerList();
                    {
                        const scheduled = await this.addSquadToMatchendSwitches(+commandSplit[ 1 ], commandSplit[ 2 ]);
                        this.warn(eosID, `Squad ${commandSplit[ 1 ]} (${commandSplit[ 2 ]}): ${scheduled} player(s) newly scheduled for switch at match end.`);
                    }
                    break;
                case "triggermatchend":
                    if (!isAdmin) {
                        this.verbose(1, `[Denied] Player ${playerName} (not admin) attempted admin command: ${subCommand}`);
                        return;
                    }
                    this.verbose(1, `[Admin] Command '${subCommand}' accepted from ${playerName}`);
                    this.warn(eosID, 'Triggering match-end switch sequence...');
                    await this.doSwitchMatchend();
                    this.warn(eosID, 'Match-end switch sequence complete.');
                    break;
                case "help":
                    if (isAdmin) {
                        this.warn(eosID, "--- Admin Controls --- \n Player: now, double, matchend, check, clear \n Squad: squad, doublesquad, matchendsquad");
                    } else {
                        const liberalMode = this.isLiberalMode();
                        if (liberalMode) {
                            this.warn(eosID, `Usage: !switch | Seed/Jensen mode active: no time or cooldown limits. Switch freely (balance rules still apply).`);
                        } else if (this.options.switchEnabledMinutes > 0) {
                            this.warn(eosID, `Usage: !switch | Available first ${this.options.switchEnabledMinutes} mins of match/join.`);
                        } else {
                            this.warn(eosID, `Usage: !switch | No time limit. Switch anytime (balance/cooldown rules still apply).`);
                        }
                    }
                    break;
                case "check":
                    if (!isAdmin) {
                        this.verbose(1, `[Denied] Player ${playerName} (not admin) attempted admin command: ${subCommand}`);
                        return;
                    }
                    this.verbose(1, `[Admin] Command '${subCommand}' accepted from ${playerName}`);
                    {
                        const ident = commandSplit.splice(1).join(' ');
                        if (!ident) {
                            this.warn(eosID, "Usage: !switch check <EOSID|SteamID|Name>");
                            return;
                        }
                        const result = await this.checkPlayer(ident);
                        if (!result) this.warn(eosID, 'Player not found.');
                        else if (result === 'multiple') this.warn(eosID, 'Multiple players found. Please use SteamID.');
                        else {
                            const now = new Date();
                            const locked = result.scrambleLockdownExpiry && result.scrambleLockdownExpiry > now;
                            const cooldownDuration = this.options.switchCooldownMinutes > 0 ? this.options.switchCooldownMinutes * 60 * 1000 : this.options.switchCooldownHours * 60 * 60 * 1000;
                            const cooldown = result.lastSwitchTimestamp && (new Date(result.lastSwitchTimestamp.getTime() + cooldownDuration) > now);
                            this.warn(eosID, `Status: ${result.playerName || result.eosID || result.steamID} | Locked: ${locked ? 'Yes' : 'No'} | Cooldown: ${cooldown ? 'Yes' : 'No'}`);
                        }
                    }
                    break;
                case "clear":
                    if (!isAdmin) {
                        this.verbose(1, `[Denied] Player ${playerName} (not admin) attempted admin command: ${subCommand}`);
                        return;
                    }
                    this.verbose(1, `[Admin] Command '${subCommand}' accepted from ${playerName}`);
                    {
                        const ident = commandSplit.splice(1).join(' ');
                        if (!ident) {
                            this.warn(eosID, "Usage: !switch clear <EOSID|SteamID|Name>");
                            return;
                        }
                        const result = await this.checkPlayer(ident);
                        if (!result || result === 'multiple') {
                            this.warn(eosID, 'Player not found or multiple matches.');
                            return;
                        }
                        await this.safeTransaction(async (t) => {
                            await this.models.PlayerCooldowns.destroy({ where: { eosID: result.eosID }, transaction: t });
                        });
                        this.warn(eosID, `Cleared cooldowns for ${result.playerName || result.eosID || result.steamID}`);
                    }
                    break;
                case "clearall":
                    if (!isAdmin) {
                        this.verbose(1, `[Denied] Player ${playerName} (not admin) attempted admin command: ${subCommand}`);
                        return;
                    }
                    this.verbose(1, `[Admin] Command '${subCommand}' accepted from ${playerName}`);
                    await this.safeTransaction(async (t) => {
                        await this.models.PlayerCooldowns.destroy({ where: {}, truncate: true, transaction: t });
                    });
                    this.warn(eosID, "All player cooldowns cleared.");
                    break;
                default:
                    await this.warn(eosID, `Unknown subcommand: "${subCommand}"`);
                    return;
            }
        } else {
            await this.server.updateSquadList();
            await this.server.updatePlayerList();

            // Detect liberal mode
            const isLiberal = this.isLiberalMode();
            const effectiveCap = isLiberal ? this.options.liberalSwitchMaxUnbalancedSlots : null;
            const availableSwitchSlots = this.getSwitchSlotsPerTeam(teamID, effectiveCap);

            // Log current team and target team for diagnostics
            const targetTeam = teamID === 1 ? 2 : 1;
            let teamPlayerCount = [null, 0, 0];
            for (let p of this.server.players) {
                teamPlayerCount[+p.teamID]++;
            }
            const balanceDiff = teamPlayerCount[1] - teamPlayerCount[2];
            const effectiveMaxSlots = effectiveCap !== null ? effectiveCap : this.options.maxUnbalancedSlots;

            this.verbose(1, playerName, 'requested a switch');
            this.verbose(1, `[Current Team] ${playerName} is on Team ${teamID}, switching to Team ${targetTeam}`);
            this.verbose(1, `[Team Counts] Team 1: ${teamPlayerCount[1]} | Team 2: ${teamPlayerCount[2]} | Balance Diff: ${balanceDiff}`);
            this.verbose(1, `[Switch Slots] Max Unbalance Cap: ${effectiveMaxSlots} | Available Slots: ${availableSwitchSlots}`);
            if (isLiberal) {
                this.verbose(1, `[Liberal Mode] ${playerName} - relaxed switch restrictions active (Seed/Jensen).`);
            }

             if (!eosID) {
                 this.verbose(1, `[PlayerCooldowns] Missing eosID for player ${playerName}, skipping switch validation`);
                 return;
             }
             const cooldownData = await this.models.PlayerCooldowns.findByPk(eosID);
             this.verbose(2, `[SCRAMBLE_CHECK] Fetched cooldown data for ${playerName} (${eosID}): ${JSON.stringify(cooldownData)}`);

            // Scramble lockdown is ALWAYS enforced, regardless of mode
            if (cooldownData) {
                this.verbose(2, `[SCRAMBLE_CHECK] cooldownData exists: ${cooldownData !== null}`);
                this.verbose(2, `[SCRAMBLE_CHECK] scrambleLockdownExpiry: ${cooldownData.scrambleLockdownExpiry}`);
                this.verbose(2, `[SCRAMBLE_CHECK] scrambleLockdownExpiry type: ${typeof cooldownData.scrambleLockdownExpiry}`);
                if (cooldownData.scrambleLockdownExpiry) {
                    const expiryDate = new Date(cooldownData.scrambleLockdownExpiry);
                    const now = new Date();
                    this.verbose(2, `[SCRAMBLE_CHECK] Expiry Date: ${expiryDate.toISOString()} | Now: ${now.toISOString()} | Expired? ${now >= expiryDate}`);
                }
            } else {
                this.verbose(2, `[SCRAMBLE_CHECK] No cooldown data found for ${playerName} (${eosID})`);
            }

            if (cooldownData && cooldownData.scrambleLockdownExpiry && new Date() < cooldownData.scrambleLockdownExpiry) {
                const remaining = Math.ceil((cooldownData.scrambleLockdownExpiry - Date.now()) / 60000);
                this.warn(eosID, `Scramble Lock: Cannot switch for ${remaining}m.`);
                this.verbose(1, `[SCRAMBLE_CHECK] ❌ DENIED ${playerName}: Scramble lockdown active - ${remaining}m remaining.`);
                return;
            } else {
                this.verbose(2, `[SCRAMBLE_CHECK] ✅ PASSED: No active scramble lockdown for ${playerName}`);
            }

            // Time window check - SKIPPED in liberal mode, and disabled entirely when switchEnabledMinutes is 0
            if (!isLiberal && this.options.switchEnabledMinutes > 0) {
                if (connectionSeconds / 60 > this.options.switchEnabledMinutes && this.getSecondsFromMatchStart() / 60 > this.options.switchEnabledMinutes) {
                    this.warn(eosID, `Time Limit: Switch allowed only in first ${this.options.switchEnabledMinutes}m of join/match.`);
                    this.verbose(1, `[Switch] Denied ${playerName}: Match time limit exceeded.`);
                    return;
                }
            }

            // Cooldown check - SKIPPED in liberal mode
            if (!isLiberal) {
                const cooldownDuration = this.options.switchCooldownMinutes > 0 ? this.options.switchCooldownMinutes * 60 * 1000 : this.options.switchCooldownHours * 60 * 60 * 1000;

                if (cooldownData && cooldownData.lastSwitchTimestamp &&
                    (Date.now() - new Date(cooldownData.lastSwitchTimestamp).getTime()) < cooldownDuration) {
                    const remaining = Math.ceil((cooldownDuration - (Date.now() - new Date(cooldownData.lastSwitchTimestamp).getTime())) / 60000);
                    this.warn(eosID, `Cooldown: Please wait ${remaining}m.`);
                    this.verbose(1, `[Switch] Denied ${playerName}: Cooldown active.`);
                    return;
                }
            }

            // Balance check (applies to both modes, but uses different cap)
            if (availableSwitchSlots <= 0) {
                this.warn(eosID, `Balance Limit: Teams would become too unbalanced.`);
                this.verbose(1, `[Switch] Denied ${playerName}: Teams unbalanced.`);
                return;
            }

             // If the requester's own teamID was already null when they asked (the ~30s window after
             // a new round starts where RCON hasn't resolved teams yet), we have no reliable "before"
             // state to confirm anything against — not here, and not in the timeout fallback below.
             // We still let the RCON command through rather than blocking it, but the outcome is
             // unconfirmable either way, so it shouldn't consume their cooldown token.
             const preSwitchTeamKnown = teamID !== null;

             let switchSuccess = false;
             try {
                 await this.switchPlayer(eosID);
                 switchSuccess = true;
             } catch (err) {
                if (err.message && (err.message.toLowerCase().includes('timeout') || err.message.toLowerCase().includes('timed out'))) {
                    this.verbose(1, `[Switch] RCON timeout for ${playerName}, verifying switch status...`);
                    await delay(3000);
                    await this.server.updatePlayerList();
                    const currentPlayer = this.server.players.find(p => p.eosID === eosID);

                    if (preSwitchTeamKnown && currentPlayer && currentPlayer.teamID !== null && currentPlayer.teamID !== teamID) {
                        this.verbose(1, `[Switch] Verified: ${playerName} switched from Team ${teamID} to Team ${currentPlayer.teamID}`);
                        switchSuccess = true;
                    } else if (!preSwitchTeamKnown || (currentPlayer && currentPlayer.teamID === null)) {
                        // Round is mid-transition and RCON hasn't resolved this player's team (before,
                        // after, or both) — genuinely unknown, not a confirmed failure. Don't write a
                        // cooldown (switchSuccess stays false) and don't tell them it failed when it
                        // may well have gone through.
                        this.verbose(1, `[Switch] Unconfirmed: ${playerName} teamID unresolved during round transition, cannot verify switch.`);
                        this.warn(eosID, "Switch status unknown (server is transitioning between rounds). Try again shortly.");
                    } else {
                        this.verbose(1, `[Switch] Verified: ${playerName} switch failed (${currentPlayer ? `still on Team ${teamID}` : 'player disconnected'})`);
                        this.warn(eosID, "Team switch failed. Please try again or contact an admin.");
                    }
                } else {
                    this.verbose(1, `Error executing switch: ${err.message}`);
                    this.warn(eosID, "Team switch failed. Please try again or contact an admin.");
                }
            }

            if (switchSuccess) {
                // In liberal mode, don't write cooldown timestamp (no cooldown enforcement)
                // In normal mode, write cooldown timestamp for next switch throttling — unless the
                // requester's pre-switch team was unresolved, in which case the outcome can't be
                // confirmed and the token shouldn't be spent (see preSwitchTeamKnown above).
                if (!isLiberal) {
                    if (preSwitchTeamKnown) {
                        try {
                            if (!eosID) {
                                this.verbose(1, `[PlayerCooldowns] Missing eosID for player ${playerName}, skipping cooldown write`);
                            } else {
                                await this.safeTransaction(async (t) => {
                                    await this.models.PlayerCooldowns.upsert({ eosID, steamID, playerName, lastSwitchTimestamp: new Date() }, { transaction: t });
                                });
                            }
                        } catch (dbErr) {
                            this.verbose(1, `[Switch] Database update failed: ${dbErr.message}`);
                        }
                    } else {
                        this.verbose(1, `[Switch] ${playerName} requested during null-teamID window — cooldown not consumed (outcome unconfirmed).`);
                        this.warn(eosID, "Switch sent, but couldn't be confirmed (server is transitioning between rounds). Use !switch again if it didn't apply.");
                    }
                }

                this.verbose(1, `[Switch] Executed for ${playerName}.`);
            }
        }
        } catch (err) {
            this.verbose(1, `Error in onChatMessage: ${err.stack}`);
        }
    }

     async doSwitchMatchend() {
         const players = await this.models.Endmatch.findAll();
         if (players.length == 0) return;
         players.forEach((pl) => {
             this.warn(pl.eosID, 'Match End: You will be switched in 15 seconds.');
         });
         await delay(15 * 1000);
      await Promise.all(players.map(async (pl) => {
              try {
                  await this.switchPlayer(pl.eosID);
              } catch (innerErr) {
                  // Not retried at the next round end — that could be 30-60+ minutes away,
                  // by which point the scheduled switch is stale and has no value. Drop it either way.
                  this.verbose(1, `[Switch] Matchend switch failed for ${pl.eosID || pl.steamID}: ${innerErr.message || innerErr}`);
              }
              return this.models.Endmatch.destroy({
                  where: {
                      id: pl.id
                  }
              });
          }));
     }

    async onRoundEnded(dt) {
        await this.cleanup();
        // Flip teamIDs for all players between rounds — Squad swaps sides each round.
        // Done BEFORE doSwitchMatchend(): that call issues real per-player switches during
        // this same window, and flipping after it would re-flip those players a second time
        // on top of their already-switched team, based on a stale pre-switch reading.
        for (let p of this.server.players)
            p.teamID = p.teamID == 1 ? 2 : 1;
        // Also flip _knownConnectedPlayers to keep it in sync with server.players
        for (const [, data] of this._knownConnectedPlayers) {
            if (data.teamID === 1 || data.teamID === 2)
                data.teamID = data.teamID === 1 ? 2 : 1;
        }
        await this.doSwitchMatchend();
        // Clear trackers to prevent cross-match exploits (but keep _knownConnectedPlayers for continuity)
        this.recentDisconnections = {};
        this._switchedOnJoin.clear();
        // Do NOT clear _knownConnectedPlayers — keep join-time/rejoin state across rounds
    }

    getTeamBalanceDifference() {
        let teamPlayerCount = [ null, 0, 0 ];
        for (let p of this.server.players)
            teamPlayerCount[ +p.teamID ]++;
        const balanceDiff = teamPlayerCount[ 1 ] - teamPlayerCount[ 2 ];

        this.verbose(1, `Balance diff: ${balanceDiff}`, teamPlayerCount);
        return balanceDiff;
    }

    /**
     * HELPER: Detect if we're in a liberal switching mode (Seed/Jensen).
     * Checks both cached layer name and gamemode against the liberal modes list.
     */
    isLiberalMode() {
        const checkLayer = (this.currentLayerName || '').toLowerCase();
        const checkMode = (this.currentGamemode || '').toLowerCase();
        return this._liberalModes.some(m => checkLayer.includes(m) || checkMode.includes(m));
    }

    /**
     * HELPER: Compute dynamic extra tolerance slots based on current player count.
     * Interpolates linearly between floor (full extra slots) and 98 players (no extra slots).
     * Uses Math.round for smooth transitions.
     */
    getDynamicExtraSlots() {
        if (!this.options.dynamicBalanceTolerance) return 0;

        const UPPER_BOUND = 98;
        const floor = this.options.dynamicBalancePlayerFloor;
        const extra = this.options.dynamicBalanceExtraSlots;

        let totalPlayers = 0;
        for (let p of this.server.players) totalPlayers++;

        // At or above upper bound: no extra tolerance
        if (totalPlayers >= UPPER_BOUND) return 0;
        
        // At or below floor: full extra tolerance
        if (totalPlayers <= floor) return extra;
        
        // Between floor and upper bound: linearly interpolate with Math.round
        const interpolated = extra * (UPPER_BOUND - totalPlayers) / (UPPER_BOUND - floor);
        return Math.round(interpolated);
    }

     /**
      * Computes available switch slots for a team, given the current balance.
      * Uses effectiveCap instead of maxUnbalancedSlots when provided (e.g. liberal mode).
      * Applies dynamic balance tolerance if enabled (interpolated extra slots), and
      * respects the 50v50 ceiling: never lets a team exceed 50 players.
      */
     getSwitchSlotsPerTeam(teamID, effectiveCap = null) {
         const balanceDifference = this.getTeamBalanceDifference();
         let cap = effectiveCap !== null ? effectiveCap : this.options.maxUnbalancedSlots;
         
         // Apply dynamic extra tolerance if enabled
         const dynamicExtra = this.getDynamicExtraSlots();
         if (dynamicExtra > 0) {
             cap += dynamicExtra;
             this.verbose(2, `[Dynamic Balance] Total players: ${this.server.players.length} | Extra slots: +${dynamicExtra} | Effective cap: ${cap}`);
         }
         
         let slots = cap - (teamID == 1 ? -balanceDifference : balanceDifference);

         // Apply 50v50 ceiling: if receiving team would exceed 50, clamp slots to prevent it
         let teamPlayerCount = [null, 0, 0];
         for (let p of this.server.players)
             teamPlayerCount[+p.teamID]++;

         const receivingTeamSize = teamPlayerCount[teamID == 1 ? 2 : 1] || 0;
         if (receivingTeamSize + slots > 50) {
             slots = Math.max(0, 50 - receivingTeamSize);
         }

         return slots;
     }

    /**
     * EVENT: UPDATED_LAYER_INFORMATION (Layer Sync)
     * Maintains currentLayerName and currentGamemode for liberal mode detection.
     */
    async onUpdatedLayerInfo() {
        const name = this.server.currentLayer?.name || null;
        const mode = this.server.currentLayer?.gamemode || null;

        if (name) {
            this.currentLayerName = name;
            this.currentGamemode = mode;
            this.verbose(1, `[Layer] Updated layer cache: ${name} (${mode})`);
        }
    }

    /**
     * EVENT: UPDATED_SERVER_INFORMATION (Secondary Layer Resolution)
     * Provides a backup path if UPDATED_LAYER_INFORMATION misses the update.
     */
    async onServerInfoUpdated(info) {
        try {
            if (info && info.currentLayer) {
                const incomingName = typeof info.currentLayer === 'string'
                    ? info.currentLayer
                    : info.currentLayer?.name;

                if (incomingName) {
                    this.currentLayerName = incomingName;
                    if (typeof info.currentLayer === 'object' && info.currentLayer.gamemode) {
                        this.currentGamemode = info.currentLayer.gamemode;
                    }
                    this.verbose(1, `[Layer] Updated from server info: ${incomingName}`);
                }
            }
        } catch (err) {
            this.verbose(1, `[onServerInfoUpdated] Error resolving layer: ${err?.message}`);
        }
    }

    async getSecondsFromJoin(eosID) {
        // 1. Check in-memory first
        let joinTime = this.playersConnectionTime[eosID];

        // 2. Check DB if memory is empty (e.g. after restart)
        // Note: This method receives eosID and queries by eosID field
        if (!joinTime) {
            const records = await this.models.PlayerCooldowns.findAll({
                where: { eosID: eosID },
                limit: 1
            });
            if (records.length > 0 && records[0].firstSeenTimestamp) {
                joinTime = new Date(records[0].firstSeenTimestamp).getTime();
                this.playersConnectionTime[eosID] = joinTime; // Hydrate memory
            }
        }

        return joinTime ? (Date.now() - joinTime) / 1000 : 0;
    }

    getSecondsFromMatchStart() {
        const matchStart = this.server.layerHistory?.[ 0 ]?.time;
        return matchStart ? (Date.now() - +matchStart) / 1000 : 0;
    }

    /**
     * EVENT: UPDATED_PLAYER_INFORMATION (RCON Poll) — The authoritative source of truth.
     *
     * Maintains its own view of connected players independent of PLAYER_CONNECTED/DISCONNECTED
     * events, so it stays correct even if those fire late, out of order, or not at all:
     * 1. Maintains _knownConnectedPlayers as Map<eosID, {teamID, name}>.
     * 2. Delta-diffs against server.players to detect NEW players and LEAVERS.
     * 3. All handlers idempotent: PLAYER_CONNECTED may race this; both guard via _switchedOnJoin.
     *
     * New players: register first-seen timestamp in memory + DB, trigger
     * switchToPreDisconnectionTeam if rejoin-to-old-team is enabled.
     *
     * Existing players: update teamID (only if non-null to avoid transient nulls).
     *
     * Missing players: delete from _knownConnectedPlayers and route to handlePlayerLeave().
     *
     * @param {object} info - SquadJS event payload (unused; uses this.server.players directly).
     */
    async onUpdatedPlayerInfo(info) {
        if (!this.server.players) return;
        
        // Build set of current eosIDs for delta-diff (new / existing / missing)
        const currentEosIDs = new Set(this.server.players.map(p => p.eosID).filter(Boolean));
        
        // NEW PLAYERS: first-seen registration + rejoin-to-old-team trigger
        for (const p of this.server.players) {
            if (p.eosID && !this._knownConnectedPlayers.has(p.eosID)) {
                // NEW PLAYER DETECTED — perform first-seen registration
                const now = Date.now();
                const eosID = p.eosID;
                if (!this.playersConnectionTime[eosID]) {
                    // A SquadJS restart wipes _knownConnectedPlayers/playersConnectionTime,
                    // so an already-connected player looks "new" here even though they
                    // joined long before. Check the DB for an existing firstSeenTimestamp
                    // before assuming a fresh join — otherwise every restart resets everyone's
                    // join-time-based windows (switchEnabledMinutes) back to zero.
                    let existingFirstSeen = null;
                    try {
                        const records = await this.models.PlayerCooldowns.findAll({ where: { eosID }, limit: 1 });
                        if (records.length > 0 && records[0].firstSeenTimestamp) {
                            existingFirstSeen = new Date(records[0].firstSeenTimestamp).getTime();
                        }
                    } catch (err) {
                        this.verbose(1, `Failed to look up existing join time for ${p.name}: ${err.message}`);
                    }

                    this.playersConnectionTime[eosID] = existingFirstSeen ?? now;
                    // Persist to DB
                    try {
                        const playerEosID = p.eosID;
                        if (!playerEosID) {
                            this.verbose(1, `[PlayerCooldowns] Missing eosID for player ${p.name}, skipping DB write`);
                        } else if (existingFirstSeen === null) {
                            await this.safeTransaction(async (t) => {
                                await this.models.PlayerCooldowns.upsert({
                                    eosID: playerEosID,
                                    steamID: p.steamID,
                                    playerName: p.name,
                                    firstSeenTimestamp: new Date(now)
                                }, { transaction: t });
                            });
                        }
                    } catch (err) {
                        this.verbose(1, `Failed to persist join time for ${p.name} (detected via UPDATED_PLAYER_INFORMATION): ${err.message}`);
                    }
                    
                    // Mark that we've triggered switchToPreDisconnectionTeam for this player
                    if (!this._switchedOnJoin.has(eosID)) {
                        this._switchedOnJoin.add(eosID);
                        // Trigger switchToPreDisconnectionTeam if applicable
                        if (this.options.switchToOldTeamAfterRejoin) {
                            const preDisconnectionData = this.recentDisconnections[eosID];
                            if (preDisconnectionData) {
                                // Schedule it for later to avoid race with onPlayerConnected
                                setTimeout(() => {
                                    this.switchToPreDisconnectionTeam({ player: p });
                                }, 100);
                            }
                        }
                    }
                }
                this._knownConnectedPlayers.set(p.eosID, { teamID: p.teamID, name: p.name });
            } else if (p.eosID) {
                // UPDATE — skip null teamID readings so a transient RCON poll glitch doesn't
                // clobber the last known-good value; onRoundEnded() flips teamID explicitly instead
                const existing = this._knownConnectedPlayers.get(p.eosID);
                if (existing && p.teamID !== null) {
                    existing.teamID = p.teamID;
                    existing.name = p.name;
                }
            }
        }

        // Detect leaves
        for (const [eosID, data] of this._knownConnectedPlayers.entries()) {
            if (!currentEosIDs.has(eosID)) {
                this._knownConnectedPlayers.delete(eosID);
                this.handlePlayerLeave(eosID, data.teamID, data.name);
            }
        }
    }

    /**
     * Records a player departure for the rejoin-to-old-team feature.
     * Stores the team they were on, timestamps the disconnect, then purges
     * any disconnection entries older than 20 minutes. Also removes the
     * player from the double-switch cooldown array.
     * @param {string} eosID - The EOS ID of the departed player.
     * @param {number} teamID - The team ID (1 or 2) they were on.
     * @param {string} playerName - Display name (for logging).
     */
    handlePlayerLeave(eosID, teamID, playerName) {
        this.verbose(1, `Player disconnected ${playerName}`);
        this.recentDisconnections[eosID] = { teamID: teamID, time: new Date() };
        
        const cutoff = Date.now() - (20 * 60 * 1000); // 20-minute retention
        for (const key in this.recentDisconnections) {
            if (this.recentDisconnections[key].time.getTime() < cutoff) delete this.recentDisconnections[key];
        }
        this.recentDoubleSwitches = this.recentDoubleSwitches.filter(p => p.eosID != eosID);
    }

    /**
     * EVENT: PLAYER_CONNECTED — Handles player joins, reconnects, and new sessions.
     *
     * Two code paths:
     * 1. Valid disconnection record (<20min old): Retain join time from DB firstSeenTimestamp.
     * 2. No record / expired (>20min): Treat as new session — reset join time, update DB.
     *
     * Guards against double-registration if onUpdatedPlayerInfo already processed this player
     * (the RCON poll often beats this log-based event to the punch). Both handlers are
     * idempotent; the first to register wins via the _switchedOnJoin guard.
     *
     * Triggers switchToPreDisconnectionTeam on rejoin if switchToOldTeamAfterRejoin is enabled.
     *
     * @param {object} info - SquadJS PLAYER_CONNECTED event payload with info.player.
     */
    async onPlayerConnected(info) {
        if (!info?.player?.eosID) return; // Early return guard — eosID is the authoritative key
        
        const eosID = info.player.eosID;
        const steamID = info.player.steamID;
        const playerName = info.player.name;
        const teamID = info.player.teamID;

        this.verbose(1, `Player connected ${playerName}`);
        const now = Date.now();

        // Guard against double-registration: onUpdatedPlayerInfo may have already registered
        // this player and called switchToPreDisconnectionTeam for it
        const alreadyRegistered = this.playersConnectionTime[eosID] && this._switchedOnJoin.has(eosID);
        if (alreadyRegistered) {
            this.verbose(1, `[Rejoin] ${playerName} already registered via UPDATED_PLAYER_INFORMATION, skipping double-registration.`);
            return;
        }

        // Check for exploit-resistant rejoin logic
        const preDisconnectionData = this.recentDisconnections[eosID];
        const disconnectionValid = preDisconnectionData && (Date.now() - preDisconnectionData.time.getTime()) < (20 * 60 * 1000);

        if (disconnectionValid) {
            // Retain join time across any short-term disconnection, regardless of team assignment
            if (!this.playersConnectionTime[eosID]) {
                try {
                    const records = await this.models.PlayerCooldowns.findAll({
                        where: { eosID: eosID },
                        limit: 1
                    });
                    if (records.length > 0 && records[0].firstSeenTimestamp) {
                        this.playersConnectionTime[eosID] = new Date(records[0].firstSeenTimestamp).getTime();
                        this.verbose(1, `[Rejoin] ${playerName} retained join time from pre-disconnection.`);
                    } else {
                        this.playersConnectionTime[eosID] = now;
                    }
                } catch (err) {
                    this.verbose(1, `Failed to hydrate join time for ${playerName}: ${err.message}`);
                    this.playersConnectionTime[eosID] = now;
                }
            }
            // Do NOT overwrite firstSeenTimestamp in the database here
        } else {
            // Reset join time (completely new session or 20 minutes expired)
            this.playersConnectionTime[eosID] = now;
            
            try {
                await this.safeTransaction(async (t) => {
                    await this.models.PlayerCooldowns.upsert({
                        eosID,
                        steamID,
                        playerName,
                        firstSeenTimestamp: new Date(now)
                    }, { transaction: t });
                });
            } catch (err) {
                this.verbose(1, `Failed to persist join time for ${playerName}: ${err.message}`);
            }
        }

        // Mark that we've handled switchToPreDisconnectionTeam for this player
        if (!this._switchedOnJoin.has(eosID)) {
            this._switchedOnJoin.add(eosID);
            this.switchToPreDisconnectionTeam(info);
        }
    }

    async switchToPreDisconnectionTeam(info) {
        if (!this.options.switchToOldTeamAfterRejoin) return;
        if (!info?.player) return;

        const eosID = info.player.eosID;
        const playerName = info.player.name;
        const teamID = info.player.teamID;

        const preDisconnectionData = this.recentDisconnections[ eosID ];
        if (!preDisconnectionData) return;

        const needSwitch = teamID != preDisconnectionData.teamID;
        this.verbose(1, `${playerName}: Switching to old team: ${needSwitch}`);

        if (Date.now() - preDisconnectionData.time > 60 * 60 * 1000) return;

         if (needSwitch) {
             setTimeout(() => {
                 this.switchPlayer(eosID)?.catch(err => {
                     this.verbose(1, `Error auto-switching ${playerName} to old team: ${err.message}`);
                 });
             }, 5000)
         }
    }

      /**
       * Performs a double switch (swap → wait → swap back) for a player.
       * @param {string} eosID - The EOS ID of the player to double-switch.
       * @param {boolean} [forced=false] - If true, skips time/cooldown checks.
       * @param {string} [senderEosID] - EOS ID of the requesting admin (for feedback on forced switches).
       */
      async doubleSwitchPlayer(eosID, forced = false, senderEosID) {
          const playerObj = eosID ? this.server.players.find(p => p.eosID === eosID) : undefined;
          const resolvedEosID = playerObj?.eosID;

          const recentSwitch = this.recentDoubleSwitches.find(e => e.eosID == eosID);
          const cooldownHoursLeft = (Date.now() - +recentSwitch?.datetime) / (60 * 60 * 1000);

          if (!forced) {
              const joinSeconds = await this.getSecondsFromJoin(resolvedEosID || eosID);
             if (this.options.doubleSwitchEnabledMinutes > 0 &&
                 joinSeconds / 60 > this.options.doubleSwitchEnabledMinutes && this.getSecondsFromMatchStart() / 60 > this.options.doubleSwitchEnabledMinutes) {
                 this.warn(eosID, `Time Limit: Double switch allowed only in first ${this.options.doubleSwitchEnabledMinutes}m of join/match.`);
                 return;
             }

             if (recentSwitch && cooldownHoursLeft < this.options.doubleSwitchCooldownHours) {
                 this.warn(eosID, `Cooldown: Double switch used recently. Wait ${this.options.doubleSwitchCooldownHours}h.`);
                 return;
             }

             if (recentSwitch)
                 recentSwitch.datetime = new Date();
             else
                 this.recentDoubleSwitches.push({ eosID: eosID, datetime: new Date() });
         }

         try {
             await this.switchPlayer(eosID);
             await delay(this.options.doubleSwitchDelaySeconds * 1000);
             await this.switchPlayer(eosID);

             if (forced && senderEosID) this.warn(senderEosID, `Player has been double-switched.`);
         } catch (err) {
             this.verbose(1, `Double switch failed for ${eosID}: ${err.message}`);
             if (forced && senderEosID) {
                 this.warn(senderEosID, `Double switch failed: ${err.message}`);
             }
         }
     }

     async switchSquad(number, team) {
         const players = this.getPlayersFromSquad(number, team);
         if (!players) return;
         for (let p of players) {
             try {
                 await this.switchPlayer(p.eosID);
             } catch (err) {
                 this.verbose(1, `Failed to switch squad member ${p.name}: ${err.message}`);
             }
         }
     }

    getPlayersFromSquad(number, team) {
        let team_id = null;

        if (+team >= 0) team_id = +team;
        else team_id = this.getFactionId(team);

        if (!team_id) {
            this.verbose(1, "Could not find a faction from:", team);
            return;
        }
        return this.server.players.filter((p) => p.teamID == team_id && p.squadID == number)
    }

     async doubleSwitchSquad(number, team) {
         const players = this.getPlayersFromSquad(number, team);
         if (!players) return;
         
         for (let p of players) {
             try {
                 await this.switchPlayer(p.eosID);
             } catch (err) {
                 this.verbose(1, `First double-switch hop failed for ${p.name}: ${err.message}`);
             }
         }
         
         await delay(this.options.doubleSwitchDelaySeconds * 1000);
         
         for (let p of players) {
             try {
                 await this.switchPlayer(p.eosID);
             } catch (err) {
                 this.verbose(1, `Second double-switch hop failed for ${p.name}: ${err.message}`);
             }
         }
     }

    /**
     * Schedules a player for an end-of-round switch, unless already scheduled.
     * Without this check, re-running !switch matchend on an already-scheduled
     * player creates a duplicate Endmatch row, and doSwitchMatchend() would
     * warn and switch them twice at round end.
     * @returns {Promise<boolean>} true if newly scheduled, false if already scheduled.
     */
    async addPlayerToMatchendSwitches(player) {
        const existing = await this.models.Endmatch.findOne({ where: { eosID: player.eosID } });
        if (existing) return false;

        await this.models.Endmatch.create({
            name: player.name,
            steamID: player.steamID,
            eosID: player.eosID,
        });
        return true;
    }

    async addSquadToMatchendSwitches(number, team) {
        const players = this.getPlayersFromSquad(number, team);
        if (!players) return 0;
        let scheduled = 0;
        for (let p of players) {
            if (await this.addPlayerToMatchendSwitches(p)) scheduled++;
        }
        return scheduled;
    }

    getFactionId(team) {
        const firstPlayer = this.server.players.find(p => p.role.toLowerCase().startsWith(team.toLowerCase()));
        if (firstPlayer) return firstPlayer.teamID;

        return null;
    }

    /**
     * Checks whether sending `name` as a name-tier AdminForceTeamChange could hit
     * someone other than the intended target — i.e. whether any OTHER connected
     * player's name contains `name` as a substring. Squad's own admin-command
     * parser partial-matches names, so a shorter name (e.g. "Hunt") can hit an
     * unrelated player whose name contains it (e.g. "Hunty").
     * @param {string} name - The name about to be sent.
     * @param {string} excludeEosID - The intended target; never their own collision.
     * @returns {boolean}
     */
    hasNameCollision(name, excludeEosID) {
        const needle = name.toLowerCase();
        return this.server.players.some(p =>
            p.eosID !== excludeEosID && typeof p.name === 'string' && p.name.toLowerCase().includes(needle)
        );
    }

    /**
     * Direct team switch via RCON.
     *
     * Tries eosID, then steamID, then name, cascading past a rejection so we
     * never fall back to a weaker identifier than this connection actually
     * needs — some servers reject eosID/steamID in AdminForceTeamChange
     * entirely, so no single identifier can be trusted to work. The name tier
     * is skipped outright if it collides with another connected player's name
     * (see hasNameCollision) or contains a literal '"' that would break the
     * quoted RCON argument — a known-bad command that could switch the wrong
     * player, or none at all, is never worth sending, even when no safer
     * identifier is available.
     *
     * @param {string} eosID - EOS ID of the player to switch.
     * @returns {Promise<string|null>} RCON response from the accepted identifier,
     *   or null if the player was not found (nothing to switch).
     * @throws {Error} If the player was found but every identifier was
     *   rejected by the server or skipped (name collision or an unsendable
     *   name) — callers must treat this as a failed switch, not a silent no-op.
     */
    async switchPlayer(eosID) {
        const player = this.getPlayerByEosID(eosID);
        if (!player) {
            this.verbose(1, `[switchPlayer] Player with eosID ${eosID} not found`);
            return null;
        }

        const identifiers = [
            { type: 'eosID', value: player.eosID },
            { type: 'steamID', value: player.steamID },
            { type: 'name', value: player.name }
        ];

        for (const { type, value } of identifiers) {
            if (!value) continue;

            if (type === 'name' && value.includes('"')) {
                // A literal double-quote would break out of the quoted RCON argument below.
                // Rather than guess at an escaping convention the game's command parser may
                // not honor, refuse to send it — same failure-safe posture as a collision.
                this.verbose(1, `[switchPlayer] Refusing name-based AdminForceTeamChange for "${value}": name contains a literal '"', which would break the quoted RCON argument. Skipping.`);
                continue;
            }

            if (type === 'name' && this.hasNameCollision(value, player.eosID)) {
                this.verbose(1, `[switchPlayer] Refusing name-based AdminForceTeamChange for "${value}": another connected player's name contains this substring, and no safer identifier (eosID/steamID) was accepted. Skipping to avoid switching the wrong player.`);
                continue;
            }

            const response = await this.server.rcon.execute(`AdminForceTeamChange "${value}"`);
            const rejected = typeof response === 'string' && /unable to find player/i.test(response);
            if (rejected) {
                this.verbose(2, `[switchPlayer] Identifier ${type}="${value}" rejected by server, trying next.`);
                continue;
            }

            return response;
        }

        this.verbose(1, `[switchPlayer] All identifiers rejected or skipped for ${player.name}.`);
        throw new Error(`AdminForceTeamChange failed for ${player.name}: all identifiers rejected or skipped`);
    }

    onNewGame() {
        // Clear layer cache for new round (will be populated by UPDATED_LAYER_INFORMATION)
        this.currentLayerName = null;
        this.currentGamemode = null;
        
        this.verbose(1, '[NEW_GAME] New game started, layer cache cleared.');
    }

    async unmount() {
        this.server.removeListener('CHAT_MESSAGE', this.onChatMessage);
        this.server.removeListener('PLAYER_CONNECTED', this.onPlayerConnected);
        this.server.removeListener('UPDATED_PLAYER_INFORMATION', this.onUpdatedPlayerInfo);
        this.server.removeListener('ROUND_ENDED', this.onRoundEnded);
        this.server.removeListener('TEAM_BALANCER_SCRAMBLE_EXECUTED', this.onScrambleExecuted);
        this.server.removeListener('NEW_GAME', this.onNewGame);
        this.server.removeListener('UPDATED_LAYER_INFORMATION', this.onUpdatedLayerInfo);
        this.server.removeListener('UPDATED_SERVER_INFORMATION', this.onServerInfoUpdated);
        if (this.options.discordClient) this.options.discordClient.removeListener('message', this.onDiscordMessage);
        this.verbose(1, 'Switch plugin was un-mounted.');
    }

    /**
     * Case-insensitive substring search for players by name.
     * @param {string} username - Search string (case-insensitive).
     * @returns {Array} Matching player objects from server.players.
     */
    getPlayersByUsername(username) {
        return this.server.players.filter(p =>
            p.name.toLowerCase().includes(username.toLowerCase())
        );
    }

    /**
     * Primary player lookup — searches server.players by eosID.
     * @param {string} eosID - Epic Online Services ID.
     * @returns {object|undefined} Player object or undefined.
     */
    getPlayerByEosID(eosID) {
        return this.server.players.find(p => p.eosID === eosID);
    }

    /**
     * Exact player lookup by SteamID64. Kept as a fallback identifier tier for
     * admin lookups — admins frequently have a SteamID on hand (ban lists,
     * external tools) but not a player's EOSID.
     * @param {string} steamID - Steam64 ID.
     * @returns {object|undefined} Player object or undefined.
     */
    getPlayerBySteamID(steamID) {
        return this.server.players.find(p => p.steamID == steamID);
    }

    /**
     * Resolves a user-provided identifier to a player object.
     * Tries eosID, then steamID (both exact match), then falls back to
     * case-insensitive name substring. Sends a warn to the requesting player
     * on failure/ambiguity.
     * @param {string} eosID - EOS ID of the requesting player (for feedback messages).
     * @param {string} ident - Search term (eosID, steamID, or player name substring).
     * @returns {object|undefined} Found player object, or undefined.
     */
    getPlayerByUsernameOrEosID(eosID, ident) {
        let ret = null;

        // Guard against an empty ident before it reaches getPlayersByUsername(), where
        // "".includes('') is true for every player — an omitted argument would otherwise
        // silently resolve to the only other connected player on a near-empty server.
        if (!ident) {
            this.warn(eosID, `No player identifier given.`);
            return;
        }

        ret = this.getPlayerByEosID(ident);
        if (ret) return ret;

        ret = this.getPlayerBySteamID(ident);
        if (ret) return ret;

        ret = this.getPlayersByUsername(ident);
        if (ret.length == 0) {
            this.warn(eosID, `No player found matching: "${ident}"`);
            return;
        }
        if (ret.length > 1) {
            this.warn(eosID, `Multiple players match "${ident}". Use exact EOSID/SteamID or a more specific name.`);
            return;
        }

        return ret[ 0 ];
    }

    /**
     * Periodic housekeeping: prunes stale DB records and clears in-memory state for disconnected players.
     * 
     * DB cleanup strategy (AND of all three conditions):
     * 1. Scramble lockdown has expired OR was never set.
     * 2. Switch cooldown has expired OR was never set.
     * 3. First-seen timestamp is null OR older than 24h.
     * 
     * This ensures we never delete a record that still has an active lock or cooldown.
     * 
     * In-memory cleanup: removes playersConnectionTime and recentDisconnections entries
     * for players no longer on the server, with a 20-minute retention grace period on
     * recentDisconnections to support rejoin-to-old-team feature.
     */
    async cleanup() {
        const switchCooldownMs = this.options.switchCooldownMinutes > 0 ? this.options.switchCooldownMinutes * 60 * 1000 : this.options.switchCooldownHours * 60 * 60 * 1000;
        const now = new Date();
        const switchCutoff = new Date(now.getTime() - switchCooldownMs);

        try {
            await this.safeTransaction(async (t) => {
                await this.models.PlayerCooldowns.destroy({
                    where: {
                        [Op.and]: [
                            { 
                                [Op.or]: [
                                    { scrambleLockdownExpiry: null },
                                    { scrambleLockdownExpiry: { [Op.lt]: now } }
                                ]
                            },
                            {
                                [Op.or]: [
                                    { lastSwitchTimestamp: null },
                                    { lastSwitchTimestamp: { [Op.lt]: switchCutoff } }
                                ]
                            },
                            // IMPORTANT: Keep join time if player is still likely on server or joined recently
                            {
                                [Op.or]: [
                                    { firstSeenTimestamp: null },
                                    { firstSeenTimestamp: { [Op.lt]: new Date(now.getTime() - (24 * 60 * 60 * 1000)) } } // Delete if older than 24h
                                ]
                            }
                        ]
                    },
                    transaction: t
                });
            });

            // Build the set of currently-connected eosIDs once, use for all cleanup loops
            const currentEosIDs = new Set(this.server.players.map(p => p.eosID).filter(Boolean));
            for (const eosID in this.playersConnectionTime) {
                if (!currentEosIDs.has(eosID)) {
                    delete this.playersConnectionTime[eosID];
                }
            }

            for (const eosID in this.recentDisconnections) {
                if (!currentEosIDs.has(eosID)) {
                    // Only delete if they've been gone beyond 20-minute retention
                    if (Date.now() - this.recentDisconnections[eosID].time > 20 * 60 * 1000) {
                        delete this.recentDisconnections[eosID];
                    }
                }
            }
        } catch (err) {
            this.verbose(1, `Cleanup error: ${err.message}`);
        }
    }

    async checkPlayer(ident) {
        // Guard against an empty ident: `LIKE '%%'` matches every non-null playerName row,
        // which could resolve to a single real record instead of failing safe.
        if (!ident) return null;

        let record = await this.models.PlayerCooldowns.findByPk(ident);
        if (record) return record;

        record = await this.models.PlayerCooldowns.findOne({ where: { steamID: ident } });
        if (record) return record;

        const records = await this.models.PlayerCooldowns.findAll({
            where: {
                playerName: { [Op.like]: `%${ident}%` }
            }
        });

        if (records.length === 0) return null;
        if (records.length > 1) return 'multiple';
        return records[0];
    }

    async onScrambleExecuted(data) {
        if (!this.options.scrambleLockdownEnabled) {
            this.verbose(2, `[SCRAMBLE_EVENT] scrambleLockdownEnabled is false — ignoring TEAM_BALANCER_SCRAMBLE_EXECUTED.`);
            return;
        }

        const { affectedPlayers } = data;
        this.verbose(1, `[SCRAMBLE_EVENT] onScrambleExecuted called with data: ${JSON.stringify(data)}`);

        if (!affectedPlayers || affectedPlayers.length === 0) {
            this.verbose(1, `[SCRAMBLE_EVENT] WARNING: affectedPlayers is empty or undefined!`);
            return;
        }

        this.verbose(1, `[SCRAMBLE_EVENT] Processing ${affectedPlayers.length} affected players for lockdown`);
        affectedPlayers.forEach((p, i) => {
            this.verbose(2, `  [${i}] eosID=${p.eosID}, steamID=${p.steamID}, name=${p.name}`);
        });

        const lockdownDuration = this.options.scrambleLockdownDurationMinutes * 60 * 1000;
        const expiry = new Date(Date.now() + lockdownDuration);
        this.verbose(1, `[SCRAMBLE_EVENT] Lockdown duration: ${this.options.scrambleLockdownDurationMinutes}min | Expiry: ${expiry.toISOString()}`);

         const records = affectedPlayers
             .filter(p => {
                 if (!p.eosID) {
                     this.verbose(1, `[SCRAMBLE_EVENT] Skipping player ${p.name} — missing eosID`);
                     return false;
                 }
                 return true;
             })
             .map(p => {
                 return { eosID: p.eosID, steamID: p.steamID ?? null, playerName: p.name, scrambleLockdownExpiry: expiry };
             });

        this.verbose(2, `[SCRAMBLE_EVENT] Created ${records.length} lockdown records for DB write`);

        try {
            this.verbose(1, `[SCRAMBLE_EVENT] Starting DB transaction to write scramble locks...`);
            await this.safeTransaction(async (t) => {
                const chunkSize = 10;
                for (let i = 0; i < records.length; i += chunkSize) {
                    const chunk = records.slice(i, i + chunkSize);
                    this.verbose(2, `[SCRAMBLE_EVENT] Writing chunk ${Math.floor(i / chunkSize) + 1}/${Math.ceil(records.length / chunkSize)} (${chunk.length} records)`);
                    await this.models.PlayerCooldowns.bulkCreate(chunk, {
                        updateOnDuplicate: ['scrambleLockdownExpiry', 'playerName', 'steamID'],
                        transaction: t
                    });
                }
            });
            this.verbose(1, `[SCRAMBLE_EVENT] ✅ SUCCESS: Switch lockdown active for ${records.length} players until ${expiry.toISOString()}.`);

            // Send Discord notification
            try {
                const embed = {
                    title: '🌪️ Scramble Lockdown Initiated',
                    color: 0xff9800,
                    description: `${affectedPlayers.length} players have been locked from switching for the next ${this.options.scrambleLockdownDurationMinutes} minutes.`,
                    fields: [
                        { name: 'Lockdown Duration', value: `${this.options.scrambleLockdownDurationMinutes} minutes`, inline: true },
                        { name: 'Expires At', value: `<t:${Math.floor(expiry.getTime() / 1000)}:R>`, inline: true },
                        { name: 'Players Affected', value: String(affectedPlayers.length), inline: true }
                    ],
                    timestamp: new Date().toISOString()
                };
                // sendDiscordMessage() (DiscordBasePlugin) always sends to `this.channel`,
                // populated from `discordChannelID` at mount time — no `channel` field to pass.
                await this.sendDiscordMessage({ embed });
            } catch (discordErr) {
                this.verbose(1, `[SCRAMBLE_EVENT] Warning: Failed to send Discord notification: ${discordErr.message}`);
            }
        } catch (err) {
            this.verbose(1, `[SCRAMBLE_EVENT] ❌ ERROR updating scramble lockdown: ${err.message}`);
            this.verbose(1, `[SCRAMBLE_EVENT] Stack trace: ${err.stack}`);
        }
    }

    async getDiagnosticInfo() {
        let dbStatus = 'Error';
        let activeLocks = 0;
        let totalStoredPlayers = 0;

        try {
            await this.options.database.authenticate();
            dbStatus = 'Connected';
            totalStoredPlayers = await this.models.PlayerCooldowns.count();
            
            const cooldownDurationMs = this.options.switchCooldownMinutes > 0 ? this.options.switchCooldownMinutes * 60 * 1000 : this.options.switchCooldownHours * 60 * 60 * 1000;
            const cooldownCutoff = new Date(Date.now() - cooldownDurationMs);

            activeLocks = await this.models.PlayerCooldowns.count({
                where: {
                    [Op.or]: [
                        { scrambleLockdownExpiry: { [Op.gt]: new Date() } },
                        { lastSwitchTimestamp: { [Op.gt]: cooldownCutoff } }
                    ]
                }
            });
        } catch (e) {
            dbStatus = `Error: ${e.message}`;
        }
        return { dbStatus, activeLocks, totalStoredPlayers };
    }

    /**
     * Handles !switch commands in Discord: diag, check, clear, clearall, help.
     *
     * SECURITY NOTE: authorization here is channel-based only — anyone who can
     * post in `discordChannelID` can run `clearall` (wipes every player's
     * cooldowns/locks) with no further role check. This assumes the configured
     * channel already restricts posting to staff via Discord's own permissions.
     * If `discordChannelID` is left unset, the gate below is a no-op and these
     * commands become usable from any channel the bot can read.
     */
    async onDiscordMessage(message) {
        if (message.author.bot) return;
        if (this.options.channelID && message.channel.id !== this.options.channelID) return;
        
        const content = message.content.trim();
        const args = content.split(' ');
        const command = args[0].toLowerCase();
        const subCommand = args[1] ? args[1].toLowerCase() : null;

        if (command !== '!switch') return;

        if (subCommand === 'diag') {
            let dbStatus = 'Error';
            let rconLatency = 'N/A';
            let standardCooldowns = 0;
            let scrambleLocks = 0;
            let playerList = 'None';

            try {
                await this.options.database.authenticate();
                dbStatus = 'Connected';

                const start = Date.now();
                await this.server.rcon.execute('ListPlayers');
                rconLatency = `${Date.now() - start}ms`;

                const now = new Date();
                const cooldownDurationMs = this.options.switchCooldownMinutes > 0 ? this.options.switchCooldownMinutes * 60 * 1000 : this.options.switchCooldownHours * 60 * 60 * 1000;
                const cooldownCutoff = new Date(now.getTime() - cooldownDurationMs);

                standardCooldowns = await this.models.PlayerCooldowns.count({
                    where: {
                        lastSwitchTimestamp: { [Op.gt]: cooldownCutoff }
                    }
                });

                scrambleLocks = await this.models.PlayerCooldowns.count({
                    where: {
                        scrambleLockdownExpiry: { [Op.gt]: now }
                    }
                });

                const lockedPlayers = await this.models.PlayerCooldowns.findAll({
                    where: {
                        [Op.or]: [
                            { scrambleLockdownExpiry: { [Op.gt]: now } },
                            { lastSwitchTimestamp: { [Op.gt]: cooldownCutoff } }
                        ]
                    },
                    order: [['scrambleLockdownExpiry', 'DESC'], ['lastSwitchTimestamp', 'DESC']],
                    limit: 10
                });

                if (lockedPlayers.length > 0) {
                    playerList = lockedPlayers.map(p => {
                        const parts = [];
                        if (p.scrambleLockdownExpiry && p.scrambleLockdownExpiry > now) {
                            parts.push(`🌪️ <t:${Math.floor(p.scrambleLockdownExpiry.getTime() / 1000)}:R>`);
                        }
                        if (p.lastSwitchTimestamp && new Date(p.lastSwitchTimestamp.getTime() + cooldownDurationMs) > now) {
                            const expiry = new Date(p.lastSwitchTimestamp.getTime() + cooldownDurationMs);
                            parts.push(`⏳ <t:${Math.floor(expiry.getTime() / 1000)}:R>`);
                        }
                        return `**${p.playerName || p.eosID || p.steamID}**: ${parts.join(' ')}`;
                    }).join('\n');
                }
            } catch (err) {
                dbStatus = `Error: ${err.message}`;
            }

            const embed = {
                title: '🖥️ Switch Plugin System Diagnostics',
                color: 0x3498db,
                fields: [
                    { name: 'System Health', value: `**Database:** ${dbStatus}\n**RCON Latency:** ${rconLatency}`, inline: false },
                    { name: 'Cooldown Statistics', value: `**Standard Cooldowns:** ${standardCooldowns}\n**Scramble Locks:** ${scrambleLocks}`, inline: false },
                    { name: 'Active Locks (Top 10)', value: playerList, inline: false }
                ]
            };
            await this.sendDiscordMessage({ embed });
        } else if (subCommand === 'check') {
            const ident = args.slice(2).join(' ');
            if (!ident) {
                await this.safeDiscordReply(message, 'Usage: `!switch check <EOSID|SteamID|Name>`');
                return;
            }
            const result = await this.checkPlayer(ident);
            if (!result) {
                await this.safeDiscordReply(message, 'Player not found in database.');
            } else if (result === 'multiple') {
                await this.safeDiscordReply(message, '⚠️ Ambiguous result: Multiple matches found. Please refine your search string or use a SteamID.');
            } else {
                const now = new Date();
                let desc = `**EOSID:** ${result.eosID}\n**SteamID:** ${result.steamID}\n**Name:** ${result.playerName || 'Unknown'}\n`;
                
                if (result.scrambleLockdownExpiry && result.scrambleLockdownExpiry > now) {
                    desc += `🔴 **Scramble Lock:** <t:${Math.floor(result.scrambleLockdownExpiry.getTime()/1000)}:R>\n`;
                } else {
                    desc += `🟢 **Scramble Lock:** None\n`;
                }

                if (result.lastSwitchTimestamp) {
                    const cooldownDuration = this.options.switchCooldownMinutes > 0 ? this.options.switchCooldownMinutes * 60 * 1000 : this.options.switchCooldownHours * 60 * 60 * 1000;
                    const nextSwitch = new Date(result.lastSwitchTimestamp.getTime() + cooldownDuration);
                    if (nextSwitch > now) {
                        desc += `🔴 **Switch Cooldown:** <t:${Math.floor(nextSwitch.getTime()/1000)}:R>\n`;
                    } else {
                        desc += `🟢 **Switch Cooldown:** Ready\n`;
                    }
                } else {
                    desc += `🟢 **Switch Cooldown:** Ready\n`;
                } 
            
                // Add First Seen to Discord check
                if (result.firstSeenTimestamp) {
                    desc += `⏱️ **Joined:** <t:${Math.floor(new Date(result.firstSeenTimestamp).getTime()/1000)}:f>\n`;
                }

                await this.sendDiscordMessage({ embed: { title: '🔍 Player Status', description: desc, color: 0x3498db } });
            }
        } else if (subCommand === 'clear') {
            const ident = args.slice(2).join(' ');
            if (!ident) {
                await this.safeDiscordReply(message, 'Usage: `!switch clear <EOSID|SteamID|Name>`');
                return;
            }
            const result = await this.checkPlayer(ident);
            if (!result || result === 'multiple') {
                await this.safeDiscordReply(message, 'Player not found or multiple matches.');
                return;
            }
            await this.safeTransaction(async (t) => {
                await this.models.PlayerCooldowns.destroy({ where: { eosID: result.eosID }, transaction: t });
            });
            await this.safeDiscordReply(message, `✅ Cleared cooldowns for **${result.playerName || result.eosID || result.steamID}**.`);
        } else if (subCommand === 'clearall') {
            await this.safeTransaction(async (t) => {
                await this.models.PlayerCooldowns.destroy({ where: {}, truncate: true, transaction: t });
            });
            await this.safeDiscordReply(message, '🗑️ All player cooldowns cleared.');
        } else if (subCommand === 'help') {
            const embed = {
                title: '📜 Switch Plugin Commands',
                description: 'Available commands:',
                fields: [
                    { name: '!switch diag', value: 'Show database diagnostics and active locks.' },
                    { name: '!switch check <ident>', value: 'Check cooldown status for a player.' },
                    { name: '!switch clear <ident>', value: 'Clear cooldowns for a specific player.' },
                    { name: '!switch clearall', value: 'Clear all player cooldowns.' },
                    { name: '!switch help', value: 'Show this help message.' }
                ]
            };
            await this.sendDiscordMessage({ embed });
        }
    }
}