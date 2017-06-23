(function(){
"use strict";

	/**
	 * @constructor
	 * @private
	 * @description プロセス実行マネージャー本体
	 */
	function Queue (_ev, _finally){
		//if(!(this instanceof Queue)){ console.warn("only to call a new instance"); return; }

		//●kitnoneイベントのキャッシュと管理データの作成
		this.ev = _ev;
		this.finally_callback = _finally || function(){};
		this.Param = { ret_cancel: false, promise_list: [] };

		//●優先度配列を取得し昇順ソートする。firstは最初に、lastは最後に。
		var PriorityList = Object.keys(Queue.Process);//KintoneEventsQueue
		PriorityList.sort(function(a,b){
			return (a=="first"||b=="last") ? -1 : (a=="last"||b=="first") ? 1 : a-b;
		});
		//console.log(PriorityList);
		//●優先順位とイベントトリガーを元にkeq（KintoneEventsQueue）から実行する処理を抽出しリスト化する
		this.QueueIndex = -1; //runの最初にインクリメントされるので初期値は-1
		this.QueueList = [];
		for(var i=0; i < PriorityList.length; i++){
			if(!Queue.Process[PriorityList[i]].hasOwnProperty(this.ev.type)){ continue; }
			this.QueueList.push( Queue.Process[PriorityList[i]][this.ev.type] );
		}
	}

	/**
	 * @description kintoneイベントトリガーの登録済み判定
	 */
	Queue.RegisteredEvents = {};

	/**
		* @description イベント発生時の処理本体を格納
		*		kinetone.events.on 内で実行するためのfunctionのキャッシュ先
		* 	<実行優先度>: { <kintoneイベントトリガー>:[実行するfunction, ...] },
		*/
	Queue.Process = {};

	/**
	 * @description kintoneエラー出力の一元管理用キャッシュ
	 * @type {{<string>フィールドコード: [<string>] エラー内容}}
	 */
	Queue.OnErrors = {};

	/**
	 * @description kintoneエラー出力の一元管理用フラグ
	 * @type {{<string>フィールドコード: [<boolean>] エラーが発生または解消しているか}}
	 */
	Queue.IsError = {};

	/**
	 * @description kintoneイベントのコールバックを実行する（kintone.events.on 内で呼ばれる）
	 */
	Queue.ProcessExecute = function(_ev, _finally){
		return (new Queue(_ev,
				//●queueの最後に実行されるコールバック
				function(resp){
					if(typeof _finally === "function"){ _finally(); }
					Queue.ErrorCheck(_ev); //エラー出力をまとめる
				} 
			)).run();
	};

	/**
	 * @private
	 * @description フィールドに表示するエラーを追加する（SetErrorから呼ばれる）
	 * @type {string} _message エラー本文
	 * @type {string} _field_code エラー表示対象のフィールドコード（省略するとイベントエラーとして扱う）
	 */
	Queue.PushError = function(_message, _field_code){
		if(!Queue.OnErrors.hasOwnProperty(_field_code)){
			Queue.OnErrors[_field_code] = [];
		}
		///完全に一致するメッセージが重複しないようにする
		if(Queue.OnErrors[_field_code].indexOf(_message) === -1){
			Queue.OnErrors[_field_code].push(_message);
		}
	};

	/**
	 * @description kintoneエラー出力を行う。KintoneEventsOnのプロセスの最後に実行（非同期でも保証）
	 */
	Queue.ErrorCheck = function(_ev){
		///▼エラーチェック準備
		///・既存のイベントエラー（イベントトリガー名で保管）を初期化する
		Queue.OnErrors[_ev.type] = [];
		///フィールドエラーが起きてたかどうかだけフラグで持っておく
		for(code in Queue.OnErrors){
			if(Queue.OnErrors[code].length > 0){ Queue.IsError[code] = true; }
			Queue.OnErrors[code] = [];
		}

		///▼エラー出力 or エラー停止
		///単一レコードを対象としたイベントの場合、フィールドに設定されたエラーを保管しておく
		///各フィールドでエラーが保管されていて、errorメッセージが入ってなければエラーが解消されたとし、
		///ここでエラーメッセージが消えるようにnullを入れる。この処理はコンテンツ横断する必要がある。
		///エラーメッセージはコンテンツごとに追加すればいいが、消すための処理はしなくていい。
		if(_ev.record){
			///changeイベントの場合はトリガーになったフィールドコードを取得する（エラー出力停止に使う）
			var trigger = null;
			if(_ev["changes"]){
				var C_Change = ".change.";
				if(_ev.type.indexOf(C_Change) >= 0){
					trigger = _ev.type.substring(_ev.type.indexOf(C_Change) + C_Change.length);
				}
			}

			///フィールド走査
			for(var code in _ev.record){
				///エラー出力がある場合
				if(Queue.OnErrors.hasOwnProperty(code) && Queue.OnErrors[code].length > 0){
					//SetError を介していないエラーも拾っておく。spica以外のプラグインとかあるので。
					var str = _ev.record[code]["error"] || ""; 
					_ev.record[code]["error"] = str + Queue.OnErrors[code].join("\n");
				}
				///エラー出力がないけどエラー停止がある場合
				///※フィールドエラー停止条件は、changeイベントで変更したフィールドが対象
				else if(trigger===code && Queue.IsError[code]){
					_ev.record[code]["error"] = null;
					Queue.IsError[code] = false;
				}
			}
		}
		///イベントエラーを出力する
		if(Queue.OnErrors[_ev.type].length > 0){
			var error_text = _ev["error"] || "";
			_ev["error"] = error_text + Queue.OnErrors[_ev.type].join("\n");
		}
	};

	/**
	 * @description KintoneEventsQueueをの実行を開始します
	 */
	Queue.prototype.run = function(){
		//●全ての再帰処理の終端（同期処理、非同期処理、どちらもここが終端になる）
		if(++this.QueueIndex >= this.QueueList.length){
			//終了時コールバック
			this.finally_callback(null);
			return this.Param.ret_cancel ? false : this.ev;
		}

		//●実行処理
		var promise_list = [];
		for(var i=0; i < this.QueueList[this.QueueIndex].length; i++){
			var resp = this.QueueList[this.QueueIndex][i](this.ev); //★実行
			if(resp === false){ this.Param.ret_cancel = true; }
			else if(resp instanceof window["kintone"]["Promise"]){ promise_list.push(resp); }
		}
		//同期実行の場合、次のプロセスを行うため再帰
		if(promise_list.length === 0){
			return this.run();
		}
		//非同期実行の場合、ここでいったん再帰は終了
		else{
			return this.unsync_run(promise_list);
		}
	};


	/**
	 * @description 非同期実行とthenでのrun実行
	 */
	Queue.prototype.unsync_run = function(promise_list){
		var promise_all = window["kintone"]["Promise"]["all"](promise_list);
		this.Param.promise_list.push(promise_all);

		//非同期処理のthenでrun再帰を行う
		return promise_all.then((function(){
			return this.run();
		}).bind(this));
	};



	/**
	 * @public
	 * @description kintone.events.onの代替として利用する
	 * @type {string|Array} _trigger kintoneイベントトリガー
	 * @type {function} _callback 実行関数
	 * @type {string|number|null} _priority 実行優先順位（昇順）
	 * 		デフォルト値は "0"
	 * 		"first": 必ず最初に実行
	 * 		"last": 必ず最後に実行
	 * 		同い優先順位のプロセスが複数指定されていたらそれらの実行順は保証されない
	 */
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
			if(!refQueue.hasOwnProperty(_trigger[i])){ refQueue[_trigger[i]] = []; }
			refQueue[_trigger[i]].push(_callback);

			//●kintone.events.onへのイベントトリガー登録
			// イベントトリガーごとに1回だけ実行される
			if(!Queue.RegisteredEvents[_trigger[i]]){
				Queue.RegisteredEvents[_trigger[i]] = true;

				//●kintone.events.onコール
				// 実行にKintoneEventsExecuteを介するので、あとからKintoneEventsOnで登録されたものも実行される
				window["kintone"]["events"]["on"]( _trigger[i], function(event){
					try{
						return Queue.ProcessExecute(event, function(){

							//●すべてのプロセスが完了したあとで行うことがあればここへ書く

						});
					}
					catch( ex ){
						console.warn(ex);
					}
				});
			}
		}
	}

})();