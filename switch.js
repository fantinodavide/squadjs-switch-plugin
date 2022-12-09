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
            duringMatchSwitchSlots: {
                required: true,
                description: "Number of switch slots, if one is free a player will instanlty get a switch",
                default: 2
            },
            endMatchSwitchSlots: {
                required: false,
                description: "Number of switch slots, players will be put in a queue and switched at the end of the match",
                default: 2
            }
        };
    }

    constructor(server, options, connectors) {
        super(server, options, connectors);

        this.onSquadCreated = this.onSquadCreated.bind(this)

        this.broadcast = (msg) => { this.server.rcon.broadcast(msg); };
        this.warn = (steamid, msg) => { this.server.rcon.warn(steamid, msg); };
    }

    async mount() {
        this.server.on('NEW_GAME', this.onNewGame);
        this.server.on('CHAT_MESSAGE', this.onChatMessage);
        this.server.on('PLAYER_DISCONNECTED', this.onPlayerDisconnected);
    }

    async onChatMessage(info) {
        const { steamID, name: playerName } = info;
        const message = info.message.toLowerCase();

        if (!message.startsWith(this.options.commandPrefix)) return;

        const commandSplit = (isNaN(message) ? message.substring(this.options.commandPrefix.length).trim().split(' ') : [ message ]);
        const subCommand = commandSplit[ 0 ];
        
        const isAdmin = info.chat === "ChatAdmin";
        switch (subCommand)
        {
            case 'switch':
                break;
            default:
                await this.warn(steamID, `Unknown vote subcommand: ${subCommand}`);
                return;
        }
    }

    async unmount() {
        this.verbose(1, 'Squad Name Validator was un-mounted.');
    }
}