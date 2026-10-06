'use strict';
const express = require('express');
const views = require('./views');
const publicRoutes = require('./routes/public');
const adminRoutes = require('./routes/admin');
const apiRoutes = require('./routes/api');

/** 组装应用：注入已打开的 db 与配置，便于测试使用内存库。 */
function createApp(db, opts = {}) {
  const app = express();
  const ctx = { db, holdTtlSeconds: opts.holdTtlSeconds != null ? opts.holdTtlSeconds : 600 };
  app.locals.ctx = ctx;
  app.disable('x-powered-by');
  app.use(express.json());
  app.use(express.urlencoded({ extended: false }));
  app.use('/api', apiRoutes(ctx));
  app.use('/admin', adminRoutes(ctx));
  app.use('/', publicRoutes(ctx));
  app.use((req, res) => res.status(404).send(views.errorPage('页面不存在', '你访问的页面不存在（404）。', 404)));
  // 统一错误兜底
  // eslint-disable-next-line no-unused-vars
  app.use((err, req, res, next) => {
    console.error(err);
    res.status(500).send(views.errorPage('服务器错误', err.message || '内部错误', 500));
  });
  return app;
}

module.exports = { createApp };
