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
                description: "Prefix of every switch command",
                default: "!switch"
            },
            // duringMatchSwitchSlots: {
            //     required: true,
            //     description: "Number of switch slots, if one is free a player will instanlty get a switch",
            //     default: 2
            // },
            endMatchSwitchSlots: {
                required: false,
                description: "Number of switch slots, players will be put in a queue and switched at the end of the match",
                default: 3
            },
            switchCooldownHours: {
                required: false,
                description: "Hours to wait before using again the !switch command",
                default: 3
            }
        };
    }

    constructor(server, options, connectors) {
        super(server, options, connectors);

        this.onChatMessage = this.onChatMessage.bind(this);
        this.onPlayerDisconnected = this.onPlayerDisconnected.bind(this);
        this.switchPlayer = this.switchPlayer.bind(this);
        this.getPlayersByUsername = this.getPlayersByUsername.bind(this);
        this.getPlayerBySteamID = this.getPlayerBySteamID.bind(this);
        this.getPlayerByUsernameOrSteamID = this.getPlayerByUsernameOrSteamID.bind(this);

        this.matchEndSwitch = new Array(this.options.endMatchSwitchSlots > 0 ? this.options.endMatchSwitchSlots : 0);
        this.recentSwitches = [];

        this.broadcast = (msg) => { this.server.rcon.broadcast(msg); };
        this.warn = (steamid, msg) => { this.server.rcon.warn(steamid, msg); };
    }

    async mount() {
        this.server.on('CHAT_MESSAGE', this.onChatMessage);
        this.server.on('PLAYER_DISCONNECTED', this.onPlayerDisconnected);
    }

    async onChatMessage(info) {
        const { steamID, name: playerName } = info;
        const message = info.message.toLowerCase();

        if (!message.startsWith(this.options.commandPrefix)) return;

        this.verbose(1, 'Received command', message)

        const commandSplit = message.substring(this.options.commandPrefix.length).trim().split(' ');
        const subCommand = commandSplit[ 0 ];

        const isAdmin = info.chat === "ChatAdmin";
        if (subCommand) {
            switch (subCommand) {
                case 'now':
                    const pl = this.getPlayerByUsernameOrSteamID(steamID, commandSplit[ 1 ])
                    if (pl) this.switchPlayer(pl.steamID)
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
                default:
                    await this.warn(steamID, `Unknown vote subcommand: ${subCommand}`);
                    return;
            }
        } else {
            this.verbose(1, playerName, 'requested a switch')
            const recentSwitch = this.recentSwitches.find(e => e.steamID == steamID);
            const cooldownHoursLeft = (+recentSwitch?.datetime - +(new Date())) / (60 * 60 * 1000);

            if (recentSwitch && cooldownHoursLeft < this.options.switchCooldownHours) {
                this.warn(steamID, `You have already used a switch in the last ${this.options.switchCooldownHours} hours`);
                return;
            }

            if (recentSwitch)
                recentSwitch.datetime = new Date();
            else
                this.recentSwitches.push({ steamID: steamID, datetime: new Date() })

            this.switchPlayer(steamID)
        }
    }

    async onPlayerDisconnected(info) {
        const { steamID, name: playerName } = info;

        this.recentSwitches = this.recentSwitches.filter(p => p.steamID != steamID);
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