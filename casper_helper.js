/*!
 * casper_helper.js
 * hack Casper, add new feature and methods
 * 
 * Date: 2012.09.22
 *
 */

// just a closure
(function casper_helper(){

    // set Background Color
    utils = require('utils');
    f = utils.format;
    colorizer = require('colorizer');
    events = require('events');
    fs = require('fs');
    http = require('http');
    mouse = require('mouse');
    pagestack = require('pagestack');
    qs = require('querystring');
    tester = require('tester');
    var Casper = require("casper");

    load_project_lib();
    // hack Casper.create
    Casper.__orig__create = Casper.create;
    Casper.create = function(options){
        // puts config into options
        options = options || {};
        //options.logLevel = options.logLevel || config.log_level;
        //options.timeout = options.timeout || 4000;
        options.viewportSize = options.viewportSize || { width: config.view_width, height: config.view_height};
        options.pageSettings = options.pageSettings || {};
        options.pageSettings.userAgent = options.pageSettings.userAgent || config.ua;
        options.exitOnError = false;
        options.onStepTimeout = function _onStepTimeout(timeout, stepNum) {
            casper.echo(f("Step timeout occured at step %s (%dms)", stepNum, timeout));
            this.page.stop();
        };
        options.onTimeout = function _onTimeout(timeout) {
            casper.test.assert(false,f("Timeout occured (%dms)", timeout));
        };
        options.onWaitTimeout = function _onWaitTimeout(timeout) {
            casper.test.assert(false,f("Wait timeout occured (%dms)", timeout));
        };
        
        var casper = Casper.__orig__create(options);

        // get all resource info
        casper.resources = [];
        casper.on('resource.received', function(resource){
            return;
            if (!resource.contentType){
                return;
            }
            if (resource.contentType.indexOf('image') != -1 ||
                resource.contentType.indexOf('javascript') != -1 ||
                resource.contentType.indexOf('text/css') != -1
                ){
                return;
            }
            if (!resource.bodySize && (!resource.headers || !resource.headers['Content-Length'])){
                return;
            }
            if (!resource.headers || !resource.headers['traceid']){
                return;
            }
            casper.resources.push([resource.url, resource.headers['traceid']]);
        })

        // set zoomFactor
        casper.on("started", function(){
            this.zoom(config.zoom);
        });

        // catching JavaScript Error
        // with a switch
        casper.isIgnoreJSError = false;
        casper.ignoreJSError = function(){
            casper.isIgnoreJSError = true;
        };
        casper.captureJSError = function(){
            casper.isIgnoreJSError = false;
        };
        casper.on("page.error", function(msg,trace){
            if( !casper.isIgnoreJSError ) {
                var m = msg;
                trace.forEach(function(item) {
                    m += " trace["+item.file+': '+item.line+"]";
                })
                //this.test.fail("JSError: "+m);
            }
        });


        /**
         * 重写casper.open方法，添加超时处理逻辑：1. 超时不终止用例执行，抛出assert失败信息.2. 如果发生超时,判断当前页面url和之前是否相同，如果不同则认为不是同一个页面，不算超时
         */
        casper.open = function open(location, settings) {
            "use strict";
            /*jshint maxstatements:30*/
            var utils = require('utils');
            var baseCustomHeaders = this.page.customHeaders,
                customHeaders = settings && settings.headers || {};
            this.checkStarted();
            settings = utils.isObject(settings) ? settings : {};
            settings.method = settings.method || "get";
            // http method
            // taken from https://github.com/ariya/phantomjs/blob/master/src/webpage.cpp#L302
            var methods = ["get", "head", "put", "post", "delete"];
            if (settings.method && (!utils.isString(settings.method) || methods.indexOf(settings.method) === -1)) {
                throw new CasperError("open(): settings.method must be part of " + methods.join(', '));
            }
            // http data
            if (settings.data) {
                if (utils.isObject(settings.data)) { // query object
                    settings.data = qs.encode(settings.data);
                } else if (!utils.isString(settings.data)) {
                    throw new CasperError("open(): invalid request settings data value: " + settings.data);
                }
            }
            // clean location
            location = utils.cleanUrl(location);
            // current request url
            this.configureHttpAuth(location, settings);
            this.requestUrl = this.filter('open.location', location) || location;
            this.emit('open', this.requestUrl, settings);
            this.log(f('opening url: %s, HTTP %s', this.requestUrl, settings.method.toUpperCase()), "debug");
            // reset resources
            this.resources = [];
            // custom headers
            this.page.customHeaders = utils.mergeObjects(utils.clone(baseCustomHeaders), customHeaders);
            // perfom request
            if(casper.requestUrlCount == undefined){
                casper.requestUrlCount = 0;
            }else{
                casper.requestUrlCount += 1
            }
            var openUrlCheckInterval = setInterval(function _check(self, start, requestUrlCount) {
                if (new Date().getTime() - start > 30000) {
                    if(casper.requestUrlCount == requestUrlCount){
                        casper.page.stop();
                    }
                    clearInterval(openUrlCheckInterval);
                }
            },30000, this, new Date().getTime(),this.requestUrlCount);
            this.page.openUrl(this.requestUrl, {
                operation: settings.method,
                data:      settings.data
            }, this.page.settings);
            // revert base custom headers
            this.page.customHeaders = baseCustomHeaders;
            return this;
        };

        /**
         * Runs a step.
         *
         * @param  Function  step
         */
        casper.runStep = function runStep(step) {
            "use strict";
            var utils = require('utils');
            this.checkStarted();
            var skipLog = utils.isObject(step.options) && step.options.skipLog === true;
            var stepInfo = f("Step %d/%d", this.step, this.steps.length);
            var stepResult;
            if (!skipLog && /^http/.test(this.getCurrentUrl())) {
                this.log(stepInfo + f(' %s (HTTP %d)', this.getCurrentUrl(), this.currentHTTPStatus), "info");
            }
            if (utils.isNumber(this.options.stepTimeout) && this.options.stepTimeout > 0) {
                var stepTimeoutCheckInterval = setInterval(function _check(self, start, stepNum) {
                    if (new Date().getTime() - start > self.options.stepTimeout) {
                        if ((self.test.currentSuiteNum + "-" + self.step) === stepNum) {
                            self.emit('step.timeout');
                            if (utils.isFunction(self.options.onStepTimeout)) {
                                self.options.onStepTimeout.call(self, self.options.stepTimeout, stepNum);
                            }
                        }
                        clearInterval(stepTimeoutCheckInterval);
                    }
                }, this.options.stepTimeout, this, new Date().getTime(), this.test.currentSuiteNum + "-" + this.step);
            }
            this.emit('step.start', step);
            try{
                stepResult = step.call(this, this.currentResponse);
            }catch(e){
                this.test.assert(false,e);
            }
            if (utils.isFunction(this.options.onStepComplete)) {
                this.options.onStepComplete.call(this, this, stepResult);
            }
            if (!skipLog) {
                this.emit('step.complete', stepResult);
                this.log(stepInfo + f(": done in %dms.", new Date().getTime() - this.startTime), "info");
            }
        };

        // detecting Resource Lost
        // with a switch
        casper.isIgnoreResourceError = false;
        casper.ignoreResourceError = function(){
            casper.isIgnoreResourceError= true;
        };
        casper.captureResourceError = function(){
            casper.isIgnoreResourceError= false;
        };
        casper.on("http.status.404", function(resource){
            if( !casper.isIgnoreResourceError ) {
                this.test.fail("ResourceError(404): url["+resource.url+"] not found.");
            }
        });
        casper.on("http.status.500", function(resource){
            if( !casper.isIgnoreResourceError ) {
                this.test.fail("ResourceError(500): url["+resource.url+"] internal error.");
            }
        });

        // add WebKit API
        casper.on("page.initialized",function(page){
            page.setFakeGeolocation(config.geo_latitude,config.geo_longitude);
            page.evaluate(function(version){
                window.external = {};
                window.external.GetVersion = "SuperJS v"+version;
            },superjs.version);
        });

        //if( config.debug ){
        //    casper.on("open", function(location, settings){
        //        log.info("opening: "+location);
        //    });
        //    casper.on("resource.received", function(resource){
        //        log.info("resource: "+JSON.stringify(resource));
        //    });
        //}

        // print HTML and PNG when fail
        //casper.test.on("fail", function(failure){
        //    casper.printBody(phantom.casperScript);
        //    casper.printScreen(phantom.casperScript);
        //});

        
        // some debug method
        casper.setBackgroundColor = function(color){
            color = color || "white";
            this.evaluate(function(color){
                document.body.bgColor = color;
            },{
                color: color
            })
        };

        // print HTML Content
        // if file given, output in the file
        casper.printBody = function(file){
            if( typeof file !== 'undefined' && file.length > 0 ){
                file = file.match(/\.html$/) ? file : file + ".html";
                fs.write( file, this.page.content, "w" );
            }else{
                log.info( this.page.content );
            }
        };
        // print Screen Picture
        casper.printScreen = function(file, clipRect){
            if( typeof file !== 'undefined' && file.length > 0 ){
                file = file.match(/\.png$/) ? file : file + ".png";
                this.capture( file, clipRect);
            }else{
                this.capture( phantom.casperScript+".png", clipRect);
            }
        };
        
        // inject jQuery
        casper.injectJQuery = function(){
            this.page.injectJs(superjs.home+'/modules/vendor/jquery-1.8.3.min.js');
            return this;
        };
        // get jQuery version
        casper.getJQueryVersion = function(){
            return this.evaluate(function(){ 
                return $().jquery; 
            });
        };

        casper.on('error', function(msg, backtrace) {
            casper.test.assert(false, msg);
        });

        /**
         * captrue page and post picture file to http server
         * @param  String selector Selector of the page element to capture
         * @return A url of picture on http server
         */ 
        casper.captureSelectorCloud = function captureSelectorCloud(selector){
            if(!casper.exists('html > head')){
                var data = casper.getHTML();
                var url = casper.evaluate(function(data){
                    var data = encodeURIComponent(data);
                    return window.__utils__.getBinary('http://wisetest.m.baidu.com:8341/picture/savexml','POST','xmldata='+data);
                 },{data:data});
                 //return url.replace('wisetest.m.baidu.com:8341','qaapp.m.baidu.com:8080'); 
                    return url;
            }else if(casper.exists('html > head') && casper.getHTML('html > head') == ""){
                var data = casper.getHTML('body');
                if(casper.saveJson){
                    data = casper.saveJson;
                }
                var url = casper.evaluate(function(data){
                    data = window.__utils__.encode(data);
                    return window.__utils__.getBinary('http://wisetest.m.baidu.com:8341/picture/savejson','POST','jsondata='+data);
                 },{data:data});
                 //return url.replace('wisetest.m.baidu.com:8341','qaapp.m.baidu.com:8080'); 
                 console.log(222222222222222)
                return url;
            }else{
                // 为解决临时文件名冲突问题，在文件名称里增加一个随机整数
                var targetFile = '._tmp_capture_file' + Math.floor(Math.random()*10000) + '.png';
                if (selector){
                    this.capture(targetFile, this.getElementBounds(selector));
                }
                else {
                    this.capture(targetFile);
                }
                if(!fs.exists(targetFile)){
                    return "capture error.";
                }
                var data = fs.read(targetFile,'b');
                // 增加上传html的功能
                var url = casper.evaluate(function(data, html){
                    data = window.__utils__.encode(data);
                    html = encodeURIComponent(html);
                    //return window.__utils__.getBinary('http://wisetest.m.baidu.com:8341/picture/save','POST','picturedata='+data);
                    return window.__utils__.getBinary('http://wisetest.m.baidu.com:8341/picture/save','POST','picturedata='+data+'&html='+html);
                 },{data:data, html:casper.getHTML()});
                fs.remove(targetFile);
                //return url.replace('wisetest.m.baidu.com:8341','qaapp.m.baidu.com:8080');
                return url;
            }
        };

        // fix phantom.exit
        casper.__orig__exit = casper.exit;
        casper.exit = function(status){
            this.__orig__exit(status);
            throw new Error("fix phantom.exit()");
        };

        // set test timeout
        var test_timeout = 5;
        if (typeof TEST_TIMEOUT != 'undefined'){
            test_timeout = TEST_TIMEOUT;
        }
        setTimeout(function(){
            casper.test.fail('测试用例运行超过'+test_timeout+'分钟');
            casper.exit(1);
        }, test_timeout*60000);
        casper.tt = 2;

        return casper;
    };
    

})();
