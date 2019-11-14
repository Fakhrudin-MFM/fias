'use strict';
/* jshint maxstatements: 100, maxcomplexity: 100*/

const fs = require('fs');
const path = require('path');
const DBF = require('stream-dbf');
const Writable = require('stream').Writable;
const encoding = require('encoding');

const classNames = {
  SEXT: 'sext',
  EXTR: 'extr',
  STREET: 'street',
  PLAN: 'plan',
  PLACE: 'place',
  CTAR: 'ctar',
  CITY: 'city',
  SETTLEMENT: 'settlement',
  AREA: 'area',
  AUTO: 'auto',
  REGION: 'region',
  ADDROBJ: 'fullAddressDict'
};

var progress = null;

module.exports.progress = function () {
  return progress ? Math.round(progress * 100) + '%' : null;
};

function wrapFileImport(fn, logger, importer) {
  return function () {
    return importFile(fn, logger, importer);
  };
}

function importFias(sourcePath, logger, importer) {
  if (fs.existsSync(path.join(sourcePath, 'ADDROBJ.DBF'))) {
    return importFile(path.join(sourcePath, 'ADDROBJ.DBF'), logger, importer);
  } else {
    let p = null;
    let i = 1;
    let fn;
    while (fs.existsSync(fn = path.join(sourcePath, 'ADDROB' + (i < 10 ? '0' : '') + i + '.DBF'))) {
      p = p ? p.then(wrapFileImport(fn, logger, importer)) : importFile(fn, logger, importer);
      i++;
    }
    return p || Promise.resolve();
  }
}

/**
 * @param {String} sourcePath
 * @param {DataRepository} dataRepo
 * @param {Logger} logger
 * @param {{}} options
 * @param {String} [options.regionFilter]
 * @returns {Promise}
 */
module.exports.start = function (sourcePath, dataRepo, logger, options) {
  var regionFilter = options.regionFilter || null;
  if (regionFilter) {
    var rF = parseInt(regionFilter);
    if (rF && rF < 10 && rF > 0) {
      regionFilter = '0' + regionFilter;
    }
  }

  var start = new Date();
  var isFias = null;

  if (fs.existsSync(path.join(sourcePath, 'ADDROBJ.DBF')) || fs.existsSync(path.join(sourcePath, 'ADDROB01.DBF'))) {
    isFias = true;
  } else if (fs.existsSync(path.join(sourcePath, 'KLADR.DBF'))) {
    isFias = false;
  } else {
    throw new Error('Не удаётся определить формат импортируемого реестра адресов.');
  }

  return Promise.resolve().
    then(function () {
    var importer = getRecordImporter(dataRepo, isFias, regionFilter, 'fias');
    if (isFias === true) {
      return importFias(sourcePath, logger, importer);
    } else {
      return importFile(path.join(sourcePath, 'KLADR.DBF'), logger, importer)
        .then(function () {
          return importFile(path.join(sourcePath, 'STREET.DBF'), logger, importer);
        });
    }
  }).then(function () {
    if (isFias === false) {
      logger.log('Обработка переподчинений');
      var cumulative = {};
      return importFile(path.join(sourcePath, 'ALTNAMES.DBF'), logger,
      /**
       * @param {Object} record
       * @param {String} [record.OLDCODE]
       * @param {String} [record.NEWCODE]
       */
      function (record) {
        if (record.LEVEL > 5 || regionFilter && !fiasRegionFilter(record.OLDCODE, regionFilter)) {
          return Promise.resolve();
        }

        var oldCode = record.OLDCODE.substring(0, record.OLDCODE.length - 2);
        var newCode = record.OLDCODE.substring(0, record.NEWCODE.length - 2);
        if (cumulative.hasOwnProperty(newCode)) {
          let nc = cumulative[newCode];
          delete cumulative[newCode];
          newCode = nc;
        }
        cumulative[oldCode] = newCode;
        return dataRepo.bulkEdit(
          classNames.ADDROBJ + '@fias',
          {CONTAINER: newCode},
          {
            skipResult: true,
            filter: {CONTAINER: oldCode}
          }
        );
      });
    }
    return Promise.resolve();
  }).then(function () {
    if (isFias === false) {
      logger.log('Удаление неактуальных записей.');
      return dataRepo.bulkDelete(classNames.ADDROBJ + '@fias', {filter: {isNotActual: true}});
    }
    return Promise.resolve();
  })/*.then(function () {
    logger.log('Проверка ссылочной целостности реестра.');
    progress = 0;
    return dataRepo.getIterator(classNames.ADDROBJ + '@fias', {
      filter: {$and: [
        {_class: {$ne: classNames.REGION}},
        {CONTAINER: {$empty: true}}
      ]},
      nestingDepth: 0,
      countTotal: true
    }).then(function (iterator) {
      progress = 0.2;
      return iteratorToChain(iterator, function (item) {
        logger.warn(`Запись ${item.getItemId()} не имеет ссылки на контейнер.`);
        return Promise.resolve();
      })();
    }).then(function () {
      progress = 0.4;
      return dataRepo.getIterator(classNames.ADDROBJ + '@fias', {
        filter: {$and: [
          {CONTAINER: {$empty: false}},
          {'CONTAINER.ID': {$empty: true}}
        ]},
        nestingDepth: 0,
        countTotal: true
      });
    }).then(function (iterator) {
      progress = 0.6;
      return iteratorToChain(iterator, function (item) {
        logger.warn(`Запись ${item.getItemId()} ссылается на несуществующий контейнер.`);
        return Promise.resolve();
      })();
    });
  })*/.then(function () {
    logger.log('Дублирование записей верхнего уровня.');
    progress = 0;
    var f = {$and: [
      {_class: {$ne: classNames.PLAN + '@fias'}},
      {_class: {$ne: classNames.STREET + '@fias'}},
      {_class: {$ne: classNames.EXTR + '@fias'}},
      {_class: {$ne: classNames.SEXT + '@fias'}}
    ]};
    if (regionFilter) {
      f.$and.push({KLADR_CODE: {$regex: '^' + regionFilter + '\\d+'}});
    }
    return dataRepo.getIterator(classNames.ADDROBJ + '@fias', {
      filter: f,
      nestingDepth: 0,
      countTotal: true
    }).then(function (iterator) {
      var count = iterator.count();
      return iteratorToChain(iterator, function (item) {
        var data = {};
        for (var p in item.base) {
          if (item.base.hasOwnProperty(p) && p[0] !== '_') {
            data[p] = item.base[p];
          }
        }
        return dataRepo.saveItem(
          item.getMetaClass().getName() + 'Short@fias',
          item.getItemId(),
          data, null, null,
          {
            skipResult: true,
            ignoreIntegrityCheck: true
          }).then(function (result) {
            progress += 1 / count;
          });
      })();
    });
  }).then(function () {
    logger.log(`Импорт справочника адресов завершен. Затрачено ${Math.round((new Date() - start) / 60000)} мин.`);
    progress = null;
    return Promise.resolve();
  });
};

function importFile(fn, logger, recordCallback) {
  return new Promise(function (resolve, reject) {
    logger.log(`Читается файл ${fn}.`);
    var counter = 0;
    var filtered = 0;
    try {
      var parser = new DBF(fn, {parseTypes: false});

      for (var i = 0; i < parser.header.fields.length; i++) {
        switch (parser.header.fields[i].name) {
          case 'NAME':
          case 'SOCR':
          case 'OFFNAME':
          case 'FORMALNAME':
          case 'SHORTNAME':
            parser.header.fields[i].raw = true;
            break;
        }
      }
      progress = 0;
      var count = parser.header.numberOfRecords;
      parser.stream.pipe(new Writable({
        write: function (record, encoding, cb) {
          try {
            recordCallback(record).then(function (f) {
              try {
                counter++;
                if (f) {
                  filtered++;
                }
                progress = counter / count;
              } catch (e) {
                logger.error(e);
              }
              cb();
            }).catch(function (err) {
              logger.error(err);
              cb();
            });
          } catch (e) {
            logger.error(e);
            cb();
          }
        },
        objectMode: true
      })).on('error', function (err) {
        logger.error(err);
      }).on('finish', function () {
        progress = null;
        logger.log(`Принято ${filtered} записей из ${parser.header.numberOfRecords}.`);
        resolve();
      });
    } catch (err) {
      reject(err);
    }
  });
}

/**
 * @param {DataRepository} dataRepo
 * @param {Boolean} isFias
 * @param {String | null} regionFilter
 * @param {String} namespace
 * @returns {Function}
 */
function getRecordImporter(dataRepo, isFias, regionFilter, namespace) {
  /**
   * @param {Object} record
   * @param {String} [record.CODE]
   */
  return function (record) {
    if (isActual(record, isFias) && isFiltered(record, isFias, regionFilter)) {
      var className = getRecordClass(record, isFias);
      var dummy = getData(record, className, isFias);
      var options = {
        skipResult: true,
        ignoreIntegrityCheck: true
      };
      return dataRepo.saveItem(className + '@' + namespace, dummy.ID, dummy, null, null, options).then(()=>true);
    }
    return Promise.resolve(false);
  };
}

/**
 * @param {Object} record
 * @param {String} [record.LIVESTATUS]
 * @param {String} [record.ACTSTATUS]
 * @param {String} [record.CODE]
 * @param {Boolean} isFias
 */
function isActual(record, isFias) {
  return isFias === true && record.LIVESTATUS === '1' && record.ACTSTATUS === '1' ||
    isFias === false &&
    (record.CODE.substring(record.CODE.length - 2) === '00' ||
    record.CODE.substring(record.CODE.length - 2) === '51');
}

/**
 * @param {Object} record
 * @param {String} [record.REGIONCODE]
 * @param {String} [record.CODE]
 * @param {Boolean} isFias
 * @param {String} [regionFilter]
 */
function isFiltered(record, isFias, regionFilter) {
  return !regionFilter ||
    isFias === true && record.REGIONCODE === regionFilter ||
    isFias === false && fiasRegionFilter(record.CODE, regionFilter);
}

function fiasRegionFilter(code, regionFilter) {
  return code.substring(0, 2) === regionFilter;
}

/**
 * @param {Object} record
 * @param {String} [record.AOLEVEL]
 * @param {String} [record.CODE]
 * @param {Boolean} isFias
 */
function getRecordClass(record, isFias) {
  if (isFias === true) {
    switch (record.AOLEVEL) {
      case '1':   return classNames.REGION;
      case '2':   return classNames.AUTO;
      case '3':   return classNames.AREA;
      case '35':  return classNames.SETTLEMENT;
      case '4':   return classNames.CITY;
      case '5':   return classNames.CTAR;
      case '6':   return classNames.PLACE;
      case '65':  return classNames.PLAN;
      case '7':   return classNames.STREET;
      case '90':  return classNames.EXTR;
      case '91':  return classNames.SEXT;
    }
  } else if (isFias === false) {
    return classNameByFiasCode(record.CODE);
  }
  throw new Error('Не удаётся определить тип записи.');
}

function classNameByFiasCode(code) {
  if (code.length === 13) {
    if (code.substring(2, 11) === '000000000') {
      return classNames.REGION;
    } else if (code.substring(5, 11) === '000000') {
      return classNames.AREA;
    } else if (code.substring(8, 11) === '000') {
      return classNames.CITY;
    } else {
      return classNames.PLACE;
    }
  } else if (code.length === 17) {
    return classNames.STREET;
  }
}

/**
 * @param {Object} record
 * @param {String} [record.AOGUID]
 * @param {String} [record.PLAINCODE]
 * @param {String} [record.SHORTNAME]
 * @param {String} [record.OFFNAME]
 * @param {String} [record.FORMALNAME]
 * @param {String} [record.OKATO]
 * @param {String} [record.OKTMO]
 * @param {String} [record.POSTALCODE]
 * @param {String} [record.PARENTGUID]
 * @param {String} [record.CODE]
 * @param {String} [record.SOCR]
 * @param {String} [record.NAME]
 * @param {String} [record.OCATD]
 * @param {String} [record.INDEX]
 * @param {String} className
 * @param {Boolean} isFias
 */
function getData(record, className, isFias) {
  var data = {};
  if (isFias === true) {
    data.ID = record.AOGUID;
    data.FIAS_AOGUID = data.ID;
    data.KLADR_CODE = record.PLAINCODE;
    data.SHORTNAME = convertCharset(record.SHORTNAME);
    data.OFFNAME = convertCharset(record.OFFNAME);
    data.FORMALNAME = convertCharset(record.FORMALNAME);
    data.OKATO = record.OKATO;
    data.OKTMO = record.OKTMO;
    data.POSTALCODE = record.POSTALCODE;
    data.CONTAINER = record.PARENTGUID;
  } else {
    data.ID = record.CODE.substring(0, record.CODE.length - 2);
    data.KLADR_CODE = record.CODE;
    data.SHORTNAME = convertCharset(record.SOCR);
    data.OFFNAME = convertCharset(record.NAME);
    data.OKATO = record.OCATD;
    data.POSTALCODE = record.INDEX;
    switch (className) {
      case classNames.AREA: data.CONTAINER = data.KLADR_CODE.substring(0, 2) + '000000000'; break;
      case classNames.CITY: data.CONTAINER = data.KLADR_CODE.substring(0, 5) + '000000'; break;
      case classNames.PLACE: data.CONTAINER = data.KLADR_CODE.substring(0, 8) + '000'; break;
      case classNames.STREET: data.CONTAINER = data.KLADR_CODE.substring(0, 11); break;
    }
    if (record.CODE.substring(record.CODE.length - 2) === '51') {
      data.CONTAINER = null;
      data.isNotActual = true;
    }
  }
  return data;
}

function convertCharset(text) {
  return encoding.convert(text, 'utf-8', 'cp866').toString();
}

function iteratorToChain(iterator, callback) {
  return function () {
    return iterator.next().then(function (item) {
      if (item) {
        return callback(item).then(iteratorToChain(iterator, callback));
      }
      return Promise.resolve();
    });
  };
}
