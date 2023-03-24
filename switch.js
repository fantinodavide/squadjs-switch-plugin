import DiscordBasePlugin from './discord-base-plugin.js';

export default class Switch extends DiscordBasePlugin {
    static get description() {
        return "Switch plugin";
    }

    static get defaultEnabled() {
        return true;
    }

    static get optionsSpecification() {
        return {
            ...DiscordBasePlugin.optionsSpecification,
            commandPrefix: {
                required: false,
                description: "Prefix of every switch command, can be an array",
                default: [ "!switch", "!change" ]
            },
            // duringMatchSwitchSlots: {
            //     required: true,
            //     description: "Number of switch slots, if one is free a player will instanlty get a switch",
            //     default: 2
            // },
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
            endMatchSwitchSlots: {
                required: false,
                description: "Number of switch slots, players will be put in a queue and switched at the end of the match",
                default: 3
            },
            switchCooldownHours: {
                required: false,
                description: "Hours to wait before using again the !switch command",
                default: 3
            },
            switchEnabledMinutes: {
                required: false,
                description: "Time in minutes in which the switch will be enabled after match start or player join",
                default: 5
            },
            doubleSwitchEnabledMinutes: {
                required: false,
                description: "Time in minutes in which the switch will be enabled after match start or player join",
                default: 5
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
            }
        };
    }

    constructor(server, options, connectors) {
        super(server, options, connectors);

        this.onChatMessage = this.onChatMessage.bind(this);
        this.onPlayerDisconnected = this.onPlayerDisconnected.bind(this);
        this.onPlayerConnected = this.onPlayerConnected.bind(this);
        this.switchPlayer = this.switchPlayer.bind(this);
        this.getPlayersByUsername = this.getPlayersByUsername.bind(this);
        this.getPlayerBySteamID = this.getPlayerBySteamID.bind(this);
        this.getPlayerByUsernameOrSteamID = this.getPlayerByUsernameOrSteamID.bind(this);
        this.doubleSwitchPlayer = this.doubleSwitchPlayer.bind(this);
        this.getFactionId = this.getFactionId.bind(this);
        this.switchSquad = this.switchSquad.bind(this);
        this.getSecondsFromJoin = this.getSecondsFromJoin.bind(this);
        this.getSecondsFromMatchStart = this.getSecondsFromMatchStart.bind(this);
        this.getTeamBalanceDifference = this.getTeamBalanceDifference.bind(this);
        this.switchToPreDisconnectionTeam = this.switchToPreDisconnectionTeam.bind(this);
        this.getSwitchSlotsPerTeam = this.getSwitchSlotsPerTeam.bind(this);
        this.onRoundEnded = this.onRoundEnded.bind(this);

        this.playersConnectionTime = [];
        this.matchEndSwitch = new Array(this.options.endMatchSwitchSlots > 0 ? this.options.endMatchSwitchSlots : 0);
        this.recentSwitches = [];
        this.recentDoubleSwitches = [];
        this.recentDisconnetions = [];

        this.broadcast = (msg) => { this.server.rcon.broadcast(msg); };
        this.warn = (steamid, msg) => { this.server.rcon.warn(steamid, msg); };
    }

    async mount() {
        this.server.on('CHAT_MESSAGE', this.onChatMessage);
        this.server.on('PLAYER_DISCONNECTED', this.onPlayerDisconnected);
        this.server.on('PLAYER_CONNECTED', this.onPlayerConnected);
        this.server.on('ROUND_ENDED', this.onRoundEnded)

        // setInterval(this.getTeamBalanceDifference,5000)
    }

    async onChatMessage(info) {
        const { steamID, name: playerName, teamID } = info.player;
        const message = info.message.toLowerCase();

        this.verbose(1, `${playerName}:\n > Connection: ${this.getSecondsFromJoin(steamID)}\n > Match Start: ${this.getSecondsFromMatchStart()}`)

        if (this.options.doubleSwitchCommands.find(c => c.toLowerCase().startsWith(message)))
            this.doubleSwitchPlayer(steamID)

        const commandPrefixInUse = typeof this.options.commandPrefix === 'string' ? this.options.commandPrefix : this.options.commandPrefix.find(c => message.startsWith(c.toLowerCase()));

        if ((typeof this.options.commandPrefix === 'string' && !message.startsWith(this.options.commandPrefix)) || (typeof this.options.commandPrefix === 'object' && this.options.commandPrefix.length >= 1 && !this.options.commandPrefix.find(c => message.startsWith(c.toLowerCase())))) return;

        this.verbose(1, 'Received command', message, commandPrefixInUse)

        const commandSplit = message.substring(commandPrefixInUse.length).trim().split(' ');
        const subCommand = commandSplit[ 0 ];


        const isAdmin = info.chat === "ChatAdmin";
        if (subCommand) {
            let pl;
            switch (subCommand) {
                case 'now':
                    if (!isAdmin) return;
                    pl = this.getPlayerByUsernameOrSteamID(steamID, commandSplit[ 1 ])
                    if (pl) this.switchPlayer(pl.steamID)
                    break;
                case 'double':
                    if (!isAdmin) return;
                    pl = this.getPlayerByUsernameOrSteamID(steamID, commandSplit[ 1 ])
                    if (pl) this.doubleSwitchPlayer(pl.steamID, true)
                    break;
                case 'squad':
                    if (!isAdmin) return;
                    await this.server.updateSquadList();
                    await this.server.updatePlayerList();
                    await this.switchSquad(+commandSplit[ 1 ], commandSplit[ 2 ])
                    break;
                case "matchend":
                    // const switchData = {
                    //     from: +info.player.teamID,
                    //     to: [ 1, 2 ].find(i => i != +info.player.teamID)
                    // }

                    // if (matchEndSwitch.filter(s => s.to == switchData.to)) {
                    //     this.matchEndSwitch[ steamID.toString() ] = 
                    // }
                    break;
                case "help":
                    let msg = `${this.options.commandPrefix}\n > now {username|steamID}\n > squad {squad_number} {teamID|teamString}`;
                    this.warn(steamID, msg);
                    break;
                default:
                    await this.warn(steamID, `Unknown subcommand: ${subCommand}`);
                    return;
            }
        } else {
            await this.server.updateSquadList();
            await this.server.updatePlayerList();
            this.verbose(1, playerName, 'requested a switch')
            this.verbose(1, `Team (${teamID}) balance difference: ${this.getSwitchSlotsPerTeam(teamID)}`)

            const recentSwitch = this.recentSwitches.find(e => e.steamID == steamID);
            const cooldownHoursLeft = (+recentSwitch?.datetime - +(new Date())) / (60 * 60 * 1000);

            if (this.getSecondsFromJoin(steamID) / 60 > this.options.switchEnabledMinutes && this.getSecondsFromMatchStart() / 60 > this.options.switchEnabledMinutes) {
                this.warn(steamID, `A switch can be requested only in the first ${this.options.doubleSwitchEnabledMinutes} mintues from match start or connection to the server`);
                return;
            }

            if (recentSwitch && cooldownHoursLeft < this.options.switchCooldownHours) {
                this.warn(steamID, `You have already used a switch in the last ${this.options.switchCooldownHours} hours`);
                return;
            }

            if (this.getSwitchSlotsPerTeam(teamID) <= 0) {
                this.warn(steamID, `Cannot switch now. Team are too unbalanced`);
                return;
            }

            if (recentSwitch)
                recentSwitch.datetime = new Date();
            else
                this.recentSwitches.push({ steamID: steamID, datetime: new Date() })

            this.switchPlayer(steamID)
        }
    }

    async onRoundEnded(dt) {
        for (let p of this.server.players)
            p.teamID = p.teamID == 1 ? 2 : 1
    }

    getTeamBalanceDifference() {
        let teamPlayerCount = [ null, 0, 0 ];
        for (let p of this.server.players)
            teamPlayerCount[ +p.teamID ]++;
        const balanceDiff = teamPlayerCount[ 1 ] - teamPlayerCount[ 2 ];

        this.verbose(1, `Balance diff: ${balanceDiff}`, teamPlayerCount)
        return balanceDiff;
    }

    getSwitchSlotsPerTeam(teamID) {
        const balanceDifference = this.getTeamBalanceDifference();
        return (this.options.maxUnbalancedSlots) - (teamID == 1 ? balanceDifference : -balanceDifference);
    }

    getSecondsFromJoin(steamID) {
        return (Date.now() - +this.playersConnectionTime[ steamID ]) / 1000
    }
    getSecondsFromMatchStart() {
        return (Date.now() - +this.server.layerHistory[ 0 ].time) / 1000 || 0; // 0 | Infinity
    }

    async onPlayerConnected(info) {
        const { steamID, name: playerName, teamID } = info.player;
        this.verbose(1, `Player connected ${playerName}`)

        this.playersConnectionTime[ steamID ] = new Date()
        this.switchToPreDisconnectionTeam(info);
    }

    async onPlayerDisconnected(info) {
        const { steamID, name: playerName, teamID } = info.player;

        // this.recentSwitches = this.recentSwitches.filter(p => p.steamID != steamID);
        this.recentDisconnetions[ steamID ] = { teamID: teamID, time: new Date() }
        this.recentDoubleSwitches = this.recentDoubleSwitches.filter(p => p.steamID != steamID);
    }

    async switchToPreDisconnectionTeam(info) {
        if (!this.options.switchToOldTeamAfterRejoin) return;

        const { steamID, name: playerName, teamID } = info.player;
        const preDisconnectionData = this.recentDisconnetions[ steamID ];
        if (!preDisconnectionData) return;

        const needSwitch = teamID != preDisconnectionData.teamID;
        this.verbose(1, `${playerName}: Switching to old team: ${needSwitch}`)

        if (Date.now() - preDisconnectionData.time > 60 * 60 * 1000) return;

        if (needSwitch) {
            setTimeout(() => {
                this.switchPlayer(steamID);
            }, 5000)
        }
    }

    doubleSwitchPlayer(steamID, forced = false) {
        const recentSwitch = this.recentDoubleSwitches.find(e => e.steamID == steamID);
        const cooldownHoursLeft = (+recentSwitch?.datetime - +(new Date())) / (60 * 60 * 1000);

        if (!forced) {
            if (this.getSecondsFromJoin(steamID) / 60 > this.options.doubleSwitchEnabledMinutes && this.getSecondsFromMatchStart() / 60 > this.options.doubleSwitchEnabledMinutes) {
                this.warn(steamID, `A double switch can be requested only in the first ${this.options.doubleSwitchEnabledMinutes} mintues from match start or connection to the server`);
                return;
            }

            if (recentSwitch && cooldownHoursLeft < this.options.doubleSwitchCooldownHours) {
                this.warn(steamID, `You have already requested a double switch in the last ${this.options.doubleSwitchCooldownHours} hours`);
                return;
            }

            if (recentSwitch)
                recentSwitch.datetime = new Date();
            else
                this.recentDoubleSwitches.push({ steamID: steamID, datetime: new Date() })
        }

        this.server.rcon.execute(`AdminForceTeamChange ${steamID}`);
        setTimeout(() => {
            this.server.rcon.execute(`AdminForceTeamChange ${steamID}`);
        }, this.options.doubleSwitchDelaySeconds)
    }

    switchSquad(number, team) {
        let team_id = null;

        // this.verbose(1, 'Layer', this.server.currentLayer.teams)

        if (+team >= 0) team_id = +team;
        else team_id = this.getFactionId(team);

        if (!team_id) {
            this.verbose(1, "Could not find a faction from:", team);
            return;
        }

        // this.verbose(1, `Switching squad ${number}, team ${team_id}`);

        for (let p of this.server.players.filter((p) => p.teamID == team_id && p.squadID == number))
            this.switchPlayer(p.steamID)
    }

    getFactionId(team) {
        team = team.toUpperCase();

        const translations = {
            'United States Army': "USA",
            'United States Marine Corps': "USMC",
            'Russian Ground Forces': "RUS",
            'British Army': "GB",
            'Canadian Army': "CAF",
            'Australian Defence Force': "AUS",
            'Irregular Militia Forces': "IRR",
            'Middle Eastern Alliance': "MEA",
            'Insurgent Forces': "INS"
        }

        for (let t in this.server.currentLayer.teams) {
            // this.verbose(1, `Checking "${team}" with "${t}-${this.server.currentLayer.teams[ t ].faction}" - ${translations[ this.server.currentLayer.teams[ t ].faction ]}`, this.server.currentLayer.teams[ t ].faction.split(' ').map(e => e[ 0 ]).join('').toUpperCase())
            if (
                (translations[ this.server.currentLayer.teams[ t ].faction ]?.toUpperCase() == team) ||
                (this.server.currentLayer.teams[ t ].faction.split(' ').map(e => e[ 0 ]).join('').toUpperCase() == team)
            ) return +t + 1;
        }

        return null;
    }

    switchPlayer(steamID) {
        return this.server.rcon.execute(`AdminForceTeamChange ${steamID}`);
    }

    async unmount() {
        this.verbose(1, 'Squad Name Validator was un-mounted.');
    }

    getPlayersByUsername(username) {
        return this.server.players.filter(p =>
            p.name.toLowerCase().includes(username.toLowerCase()) &&
            p.name.length / username.length < 3
        )
    }
    getPlayerBySteamID(steamID) {
        return this.server.players.find(p => p.steamID == steamID)
    }

    getPlayerByUsernameOrSteamID(steamID, ident) {
        let ret = null;

        ret = this.getPlayerBySteamID(ident);
        if (ret) return ret;

        ret = this.getPlayersByUsername(ident);
        if (ret.length == 0) {
            this.warn(steamID, `Could not find a player whose username includes: "${ident[ 1 ]}"`)
            return;
        }
        if (ret.length > 1) {
            this.warn(steamID, `Found multiple players whose usernames include: "${ident[ 1 ]}"`)
            return;
        }

        return ret[ 0 ];
    }
}