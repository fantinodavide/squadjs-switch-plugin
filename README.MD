## SquadJS Switch Plugin
Switch plugin for SquadJS.

### Commands

#### User Commands
- `!switch` - request a team change
- `!change` - alias of !switch (multiple aliases can be configured)

#### Admin Commands
- `!switch now {username}` - Changes team of a player by its username.
- `!switch now {steamID}` - Changes team of a player by its SteamID64.

### Example configuration
```json
{
    "plugin": "Switch",
    "commandPrefix": [ "!switch", "!change" ],
    "enabled": true,
    "discordClient": "discord",
    "channelID": "112233445566778899",
    "switchCooldownHours": 3,
    "doubleSwitchCommands": [ "!bug", "!stuck", "!doubleswitch" ],
    "doubleSwitchCooldownHours": 0.5
}
```
