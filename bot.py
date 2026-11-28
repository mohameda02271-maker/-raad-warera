import asyncio
import os
from pathlib import Path
import discord
from discord import app_commands
from discord.ext import commands
from dotenv import load_dotenv
import perms
import warera


load_dotenv()


class WareraMUBot(commands.Bot):
    def __init__(self) -> None:
        intents = discord.Intents.default()
        intents.members = True
        super().__init__(command_prefix="!", intents=intents)

    async def on_tree_error(self, interaction: discord.Interaction, error: app_commands.AppCommandError) -> None:
        if isinstance(error, app_commands.CheckFailure):
            msg = perms.NO_PERMISSION_MSG
        else:
            msg = f"❌ Error: `{error}`"
        try:
            if interaction.response.is_done():
                await interaction.followup.send(msg, ephemeral=True)
            else:
                await interaction.response.send_message(msg, ephemeral=True)
        except Exception:
            pass

    async def setup_hook(self) -> None:
        self.tree.on_error = self.on_tree_error
        api_key = os.getenv("WARERA_API_KEY")
        if api_key:
            warera.set_api_key(api_key)

        cogs_dir = Path(__file__).parent / "cogs"
        for file in cogs_dir.glob("*.py"):
            if not file.name.startswith("_"):
                await self.load_extension(f"cogs.{file.stem}")

        await self.tree.sync()

    async def on_ready(self) -> None:
        print(f"Logged in as {self.user} (ID: {self.user.id})")


async def main() -> None:
    token = os.getenv("DISCORD_TOKEN")
    if not token:
        raise RuntimeError("DISCORD_TOKEN is missing in environment variables.")

    bot = WareraMUBot()
    async with bot:
        await bot.start(token)


if __name__ == "__main__":
    asyncio.run(main())
