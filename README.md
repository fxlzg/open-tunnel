# open-tunnel

零配置内网穿透工具，将本地服务一键暴露到公网。

## 安装

无需安装任何依赖，仅需 Node.js 和系统自带 OpenSSH（Windows 10+ 内置）。

```
git clone https://github.com/fxlzg/open-tunnel.git
cd open-tunnel
```

## 使用

```bash
node index.js --port 3000      # 暴露本地 3000 端口
node index.js 8080             # 简写
node index.js -s myapp         # 指定子域名
node index.js --help           # 帮助
```

## 原理

通过 SSH 反向隧道连接 serveo.net，无需注册、无需安装额外依赖。支持自动重连和 SSH 密钥管理。

## 后端

| 后端 | 依赖 | 特点 |
|------|------|------|
| serveo (默认) | 系统 SSH | 零依赖，自动生成密钥 |
| bore | bore.exe | 需单独下载 |

## License

MIT
