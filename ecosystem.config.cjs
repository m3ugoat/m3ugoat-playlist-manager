module.exports = {
  apps: [
    {
      name: "m3ugoat",
      script: "npm",
      args: "run start",
      env: {
        PORT: 8080,
        NODE_ENV: "production"
      },
    },
  ],
};
