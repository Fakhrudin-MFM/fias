'use strict';

const respond = require('modules/ionadmin/backend/respond');
const ionAdmin = require('modules/ionadmin/index');
const importAddressCatalog = require('../address-import');
const LogRecorder = require('core/impl/log/LogRecorder');

/**
 * @param {{}} options
 * @param {{}} options.module
 * @param {Logger} options.log
 * @param {String} options.destNamespace
 * @param {String} options.src
 * @constructor
 */
function ImportController(options) {

  var recorder = null;
  var importer = null;
  var buffer = null;

  this.init = function () {
    options.module.get('/ionadmin/address-import', function (req, res) {
        respond(res, scope => {
          try {
            ionAdmin.render('address-import', {
              req, res,
              title: 'Импорт реестра адресов'
            });
          } catch (err) {
            options.log.error(err);
            res.status(500).send(err);
          }
        });
      });
    options.module.post('/ionadmin/address-import/start', function (req, res) {
      respond(res, scope => {
        try {
          if (importer) {
            throw new Error('На данный момент импорт уже выполняется.');
          }
          recorder = new LogRecorder({target: scope.sysLog, messageTypes: ['log', 'info', 'warn', 'err']});
          let sourcePath = options.src;
          if (!sourcePath) {
            scope.sysLog.error(new Error('Не настроена директория файлов справочника адресов.'));
            res.sendStatus(500);
            return;
          }
          let rF = req.body.regionFilter;
          recorder.start();
          importer = importAddressCatalog
            .start(sourcePath, scope.dataRepo, scope.sysLog, {regionFilter: rF})
            .catch((err) => {
              scope.sysLog.error(err);
              importer = null;
              buffer = recorder.stop();
            })
            .then(() => {
              importer = null;
              buffer = recorder.stop();
            });
          res.send(`Запущен импорт реестра адресов` + (rF ? ` с фильтрацией по ${rF} региону.` : `.`));
        } catch (err) {
          scope.sysLog.error(err);
          res.sendStatus(500);
        }
      });
    });

    options.module.post('/ionadmin/address-import/info', function (req, res) {
      respond(res, scope => {
        try {
          var result = {};
          if (importer) {
            result.progress = importAddressCatalog.progress();
            if (recorder) {
              result.logs = recorder.stop();
              recorder.start();
            }
          } else {
            result.logs = buffer;
            result.finished = true;
            buffer = null;
          }
          res.send(result);
        } catch (err) {
          scope.sysLog.error(err);
          res.sendStatus(500);
        }
      });
    });
    return Promise.resolve();
  };
}

module.exports = ImportController;
