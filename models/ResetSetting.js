import mongoose from "mongoose";

const ResetSettingSchema = new mongoose.Schema({
  guildId: { type: String, required: true, unique: true },
  channelId: { type: String, required: true },
  enabled: { type: Boolean, default: true },
});

export default mongoose.models.ResetSetting || mongoose.model("ResetSetting", ResetSettingSchema);
