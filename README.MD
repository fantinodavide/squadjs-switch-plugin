## SquadJS Switch Plugin
Switch plugin for SquadJS.

### Commands

#### User Commands
- `!switch` - request a team change
- `!change` - alias of !switch (multiple aliases can be configured)

#### Admin Commands
- `!switch now {username}` - Changes team of a player by its username.
- `!switch now {steamID}` - Changes team of a player by its SteamID64.
- `!switch squad {squad_number} {team_short_name}` - Changes team of all the players of a squad by squad number and team short name.
- `!switch squad {squad_number} {teamID}` - Changes team of all the players of a squad by squad number and team ID.
- `!switch double {username}` - Double switches team of a player by its username.
- `!switch double {steamID}` - Double switches team of a player by its SteamID64.

### Example configuration
```json
{
    "plugin": "Switch",
    "commandPrefix": [ "!switch", "!change" ],
    "enabled": true,
    "discordClient": "discord",
    "channelID": "112233445566778899",
    "switchCooldownHours": 3,
    "switchEnabledMinutes": 5,
    "doubleSwitchCommands": [ "!bug", "!stuck", "!doubleswitch" ],
    "doubleSwitchCooldownHours": 0.5,
    "doubleSwitchEnabledMinutes": 5,
    "maxUnbalancedSlots": 5,
    "switchToOldTeamAfterRejoin": false,
    "database": "sqlite"
}
```
