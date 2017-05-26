(function(){
"use strict";

	/**
	 * @constructor
	 */
	function Queue(_event, _finally){
		if(!(this instanceof Queue)){ return undefined; }

		//●kitnoneイベントのキャッシュと管理データの作成
		this.ev = _event;
		this.finally_callback = _finally || function(){};
		this.Param = { cancel: false, promise: [], root_promise: null, root_resolve:null, root_reject: null };

		//●優先度配列を取得し昇順ソートする。firstは最初に、lastは最後に。
		var PriorityList = Object.keys(Queue.Origin);
		PriorityList.sort(function(a,b){
			return (a=="first"||b=="last") ? -1 : (a=="last"||b=="first") ? 1 : a-b;
		});

		//●優先順位とイベントトリガーを元にKintoneEventsQueueから実行する処理を抽出しリスト化する
		this.QueueIndex = 0;
		this.QueueList = [];
		for(var i=0; i < PriorityList.length; i++){
			if(!Queue.Origin[PriorityList[i]].hasOwnProperty(this.ev.type)){ continue; }
			this.QueueList.push( Queue.Origin[PriorityList[i]][this.ev.type] );
		}
	}
	Queue.Origin = {};
	Queue.RegisteredEvents = {};
	Queue.prototype.run = function(){
		//●再帰実行の終端
		if(this.QueueIndex >= this.QueueList.length){
			//同期処理のみの場合
			if(this.Param.promise.length == 0){
				//終端コールバックを実行
				this.finally_callback(null);
			}
			//非同期処理がある場合
			else {
				//●起点のkitone.Promiseを作成
				this.Param.root_promise = new kintone.Promise((function(_resolve, _reject){
					this.Param.root_resolve = _resolve;
					this.Param.root_reject = _reject;
					return this.Param.promise[0];
				}).bind(this));
			}
			return;
		}

		//●同期実行
		if(this.Param.promise.length == 0){
			this.exec(this.QueueIndex); //★実行
			this.QueueIndex++;
			this.run(); //再帰
		}
		//●非同期実行の設定
		else {
			///thenを定義（QueueIndexをクロージャに渡しておく）
			(function(_index){
				(this.Param.promise[this.Param.promise.length - 1]).then((function(_res){
					return this.exec(_index);
				}).bind(this));
			}).call(this, this.QueueIndex);
			this.QueueIndex++;
			this.run(); //再帰
		}

		if(this.Param.root_promise){ return this.Param.root_promise; }
		else if(this.Param.cancel){ return false; }
		return this.ev;
	};
	Queue.prototype.exec = function(queue_index){
		if(queue_index >= this.QueueList.length){ return this.ev; }

		var CurrentQueue = this.QueueList[queue_index];
		//同期実行開始
		var promise_list = [];
		for(var i=0; i < CurrentQueue.length; i++){
			var resp = CurrentQueue[i](this.ev); //★同期実行
			if(resp === false){ this.Param.cancel = true; }
			else if(resp instanceof kintone.Promise){ promise_list.push(resp); }
		}

		//非同期処理が含まれている場合
		if(promise_list.length > 0){
			var promise_all = kintone.Promise.all(promise_list);
			this.Param.promise.push(promise_all);

			//最後の非同期処理の場合はthenで終端コーバックを実行する
			if(queue_index === (this.QueueList.length - 1)){
				promise_all.then((function(_res){
					this.finally_callback(_res);
					this.Param.root_resolve(this.Param.cancel ? false : this.ev);
				}).bind(this));
			}

			return promise_all;
		}

		return this.ev;
	};

	window["KintoneEventsOn"] = function(_trigger, _callback, _priority){
			if(typeof _trigger === "string"){ _trigger = [_trigger]; }
			if(!(_trigger instanceof Array) || (typeof _callback !== "function")){ return false; }

			//優先順位文字列を作成
			_priority = _priority || "0";
			if(typeof _priority != "string"){ _priority = _priority.toString(); }

			//●優先順位をキーとするキャッシュ先を作成・取得
			Queue.Origin[_priority] = Queue.Origin[_priority] || {};
			var refQueue = Queue.Origin[_priority];

			//●イベントトリガーをキーとして実行処理本体のキャッシュ先を作成・取得し、callbackを格納
			for(var i=0; i < _trigger.length; i++){
				refQueue[_trigger[i]] = refQueue[_trigger[i]] || [];
				refQueue[_trigger[i]].push(_callback);

				//●kintone.events.onへのイベントトリガー登録 ※各ハンドラーごとに1回だけ実行される
				if(!Queue.RegisteredEvents[_trigger[i]]){
					Queue.RegisteredEvents[_trigger[i]] = true;

					//●kintone.events.onコール
					kintone.events.on( _trigger[i], function(event){
						try{
							//実行
							return (new Queue(event, function(resp){
								//※すべてのプロセスが終了したあとでなにかしたい場合はここで
							})).run();
						}
						catch( ex ){
							console.warn(ex);
						}
					});
				}
			}
		};

})();