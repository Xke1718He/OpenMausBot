const fs = require("node:fs");
const { parse } = require("yaml");

const config = parse(fs.readFileSync(`${__dirname}/electron-builder.yml`, "utf8"));
config.artifactName = "OpenMausBot-${version}-ubuntu20.04-${arch}.${ext}";
config.directories.output = "release/ubuntu20.04";
config.linux.target = [{ target: "deb", arch: "x64" }];
config.linux.extraResources = config.linux.extraResources.filter(resource => resource.from !== "dist-native/cua-linux-x64");
config.linux.extraResources.push({ from: "dist-native/x11-compat", to: "x11-compat" });
config.deb.fpm.push("--depends", "xdotool", "--depends", "x11-utils", "--depends", "x11-apps");
config.publish = [];
module.exports = config;
