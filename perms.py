"""Owner/admin checks. Owner = Administrator permission, a user id in OWNER_USER_ID,
or a member holding a role id listed in OWNER_ROLE_ID."""
import discord
from discord import app_commands

import config


def is_owner(interaction: discord.Interaction) -> bool:
    user = interaction.user
    if user.id in config.owner_user_ids():
        return True
    perms = getattr(user, "guild_permissions", None)
    if perms is not None and perms.administrator:
        return True
    role_ids = config.owner_role_ids()
    if role_ids and any(getattr(r, "id", None) in role_ids for r in getattr(user, "roles", [])):
        return True
    return False


def owner_only():
    async def predicate(interaction: discord.Interaction) -> bool:
        return is_owner(interaction)

    return app_commands.check(predicate)


NO_PERMISSION_MSG = "⛔ الأمر ده لصاحب الوحدة أو الأدمن بس."
