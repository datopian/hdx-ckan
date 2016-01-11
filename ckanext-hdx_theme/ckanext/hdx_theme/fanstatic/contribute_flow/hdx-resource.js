$(function(){

    /*
        A Backbone module for work with CKAN Package Resources for the HDX
        Contribute Flow.

        TODO:
        - Handle server validation errors on create/update of resources
        - decide what user action submits create/update requests (button
          click?, change events?)
    */

    // MODELS

    var Resource = Backbone.Model.extend({

        // A model for CKAN resources. Most of the stuff here is to align
        // Backbone verbs with the CKAN api endpoints.
        fileAttribute: 'upload',

        methodToURL: {
            'create': '/api/action/resource_create',
            'read': '/api/action/resource_show?id=',
            'patch': '/api/action/resource_patch?id=',
            'update': '/api/action/resource_update?id=',
            'delete': '/api/action/resource_delete'
        },

        sync: function(method, model, options) {
            // console.log('syncing resource with method: ' + method);
            options = options || {};
            options.emulateHTTP = true;

            options.url = model.methodToURL[method.toLowerCase()];

            if (_.contains(['read', 'update', 'patch'], method)) {
                options.url += model.id;
            } else if (method == 'delete') {
                options.data = JSON.stringify({id: model.id});
            }
            return Backbone.sync.apply(this, arguments);
        },

        parse: function(data) {
            // Check whether the data has a 'package_id' key to determine if we've
            // been passed an object directly. Otherwise, we may have the results
            // of a resource_show, in which case the data is the value of the
            // 'result' key.
            var ret;
            if (_.has(data, 'package_id')) {
                ret = data;
            } else if (_.has(data, 'result')) {
                ret = data.result;
            }
            return ret;
        }
    });

    var PackageResources = Backbone.Collection.extend({
        // A collection of resources for a package.
        model: Resource,
        comparator: 'position',
        removedModels: [],  // An array for models set to be removed during next sync.

        initialize: function(models, options) {
            this.package_id = options.package_id;
        },

        url: function() {
            return '/api/action/package_show?id=' + this.package_id;
        },

        parse: function(data) {
            return data.result.resources;
        },

        saveAll: function(pkg_id) {
            var deferred = new $.Deferred();
            var index = 0;
            var resources = this;

            var saveResources = function () {
                /**
                 * We need to save the resources sequentially to avoid
                 * race conditions on the server side
                 */
                var model = resources.models[index];
                model.set('package_id', pkg_id);
                //if ( model.get('resource_type') == 'file.upload' && !model.get('upload')){
                //    model.set('upload', '');
                //}
                var promise = model.save();
                if (index + 1 < resources.length) {
                    index++;
                    promise.then(saveResources);
                } else {
                    promise.then(function(){
                        deferred.resolve();
                    });
                }
            };

            if (resources.length)
                saveResources();
            else
                deferred.resolve();

            return deferred.promise();
        },

        destroyRemovedModels: function() {
            // Sequentially destroy all models on the server that are in the
            // removedModels array, i.e. marked for deletion.

            var deferred = new $.Deferred();
            var index = 0;
            var resources = this;

            var destroyResources = function() {
                var model = resources.removedModels[index];
                var promise = model.destroy();
                if (index + 1 < resources.removedModels.length) {
                    index++;
                    promise.then(destroyResources);
                } else {
                    promise.then(function() {
                        deferred.resolve();
                    });
                }
            };

            if (resources.removedModels.length)
                destroyResources();
            else
                deferred.resolve();

            return deferred.promise();
        }
    });


    // VIEWS

    var PackageResourcesListView = Backbone.View.extend({
        el: '#resource-list',

        events: {
            'sort-updated': 'onSortOrderChange'
        },

        initialize: function() {
            this.resource_list = this.$('.resources');
            if (this.collection.package_id !== null){
                this.collection.fetch({
                success: function(){
                    this.render();
                }.bind(this),
                error: function(e){
                    console.log('Cannot render: ' + e);
                }.bind(this)});
            }
            this.listenTo(this.collection, 'sync add remove', this.render);
            this.listenTo(this.collection, 'add remove', this.updateTotal);
            this.listenTo(this.collection, 'remove', this.onSortOrderChange);

            // Initialize drag n drop sorting
            Sortable.create(this.resource_list[0], {
                animation: 250,
                ghostClass: "drag-drop-ghost",
                handle: ".drag-handle",
                onUpdate: function (e){
                    this.$el.trigger('sort-updated');
                }.bind(this)
            });
        },

        render: function() {
            this.resource_list.empty();
            this.collection.each(function(resource) {
                this.addOne(resource);
            }, this);
            return this;
        },

        addOne: function(resource) {
            var view = new ResourceItemView({model: resource});
            this.resource_list.append(view.render().el);
        },

        updateTotal: function() {
            var total_text = this.collection.length == 1 ? "1 Resource" : this.collection.length + " Resources";
            this.$('.resources_total').text(total_text);
        },

        onSortOrderChange: function(e) {
            var has_changed = false;
            this.collection.each(function(resource, i) {
                var new_pos = resource.view.$el.index();
                if (resource.get('position') != new_pos) {
                    has_changed = true;
                    resource.set({position: new_pos});
                }
            });
            if (has_changed) {
                this.collection.sort();
                this.render();
            }
        }
    });

    var ResourceItemView = Backbone.View.extend({
        // A template view for each Resource.
        tagName: 'div',
        className: 'drag-drop-component source-file',
        template: _.template($('#resource-item-tmpl').html()),

        events: {
            'click .update_resource': 'onUpdateBtn',
            'click .delete_resource': 'onDeleteBtn',
            'change .resource_file_field': 'onFileChange',
            'change input[type=radio].resource-source': 'onSourceChange',
            'change .source-file-fields .form-control': 'onFieldEdit',
            'click .dropbox a': 'onDropboxBtn',
            'click .googledrive a': 'onGoogleDriveBtn'
        },

        initialize: function() {
            this.model.view = this;
            this.listenTo(this.model, "change", this.render);
            this.listenTo(this.model, "destroy", this.remove);

            this.googlepicker = this.initGooglePicker();
        },

        initGooglePicker: function() {
            var picker = new FilePicker({
                apiKey: 'AIzaSyDI2YqaXNwndxy6UEisT-5fUeJ2FMtz0VY',
                clientId: '378410536565-mvin02sm8rbr0f8rq9q9injarh93ego4.apps.googleusercontent.com',
                scope: 'https://www.googleapis.com/auth/drive.readonly',
                onSelect: this.cloudFileURLSelected.bind(this)
            });
            return picker;
        },

        render: function() {
            var html = this.template(this.model.attributes);
            this.$el.html(html);
            if (this.model.get('url')) {
                this._setUpForSourceType('source-file-selected');
            }
            return this;
        },

        onSourceChange: function(e){
            this._setUpForSourceType("source-" + e.target.value);
        },

        onUpdateBtn: function(e) {
            this.updateResource();
        },

        onDeleteBtn: function(e){
            this.deleteResource();
        },

        onDropboxBtn: function(e) {
            this.createDropboxChooser();
            e.preventDefault();
        },

        onGoogleDriveBtn: function(e) {
            this.createGoogleDrivePicker();
            e.preventDefault();
        },

        onFieldEdit: function(e) {
            this.model.set(e.target.name, e.target.value);
        },

        onFileChange: function(e) {
            // If a file has been selected, set up interface with file path.
            this._setUpWithPath($(e.currentTarget).val(), true);
            this._setUpForSourceType("source-file-selected");
        },

        updateResource: function() {
            // Update the Resource from this view's form fields.

            var update_form_array = this.$el.find(':input').serializeArray();

            // Serialize in the correct JSON format.
            var form_data = {format: 'txt'};
            _.map(update_form_array, function(x){form_data[x.name] = x.value;});

            this.model.set('upload', this.$('.resource_file_field')[0].files[0]);
            this.model.save(form_data, {
                wait: true,
                success: function(model, response, options) {
                    // console.log('successfully updated model');
                }.bind(this),
                error: function(model, response, options) {
                    // ::TODO:: Handle validation errors returned by server here.
                    console.log('Could not update the resource');
                    console.log(response.responseJSON.error);
                }.bind(this)
            });
        },

        deleteResource: function(){
            // Remove model from collection and push it to the removedModels
            // array. These will be destroyed if the dataset update is
            // submitted.
            var collection = this.model.collection;
            collection.removedModels.push(collection.remove(this.model));
        },

        createDropboxChooser: function() {
            options = {
                success: function(files) {
                    var file = files[0];
                    this.cloudFileURLSelected(file.link, file.name);
                }.bind(this),
                linkType: "preview"
            };
            Dropbox.choose(options);
        },

        createGoogleDrivePicker: function() {
            this.googlepicker.open();
        },

        cloudFileURLSelected: function(url, filename) {
            this._setUpWithPath(url, false, filename);
            this._setUpForSourceType("source-file-selected");
            // switch resource-source radio to URL input
            this.$('input:radio.resource-source[value=url]').prop('checked', true);
        },

        _setUpForSourceType: function(source_class) {
            // Set up interface for the source type based on source_class.
            var source_classes = ['source-url', 'source-file', 'source-file-selected'];
            $.each(source_classes, function(i, v){
                this.$el.removeClass(v);
            }.bind(this));
            this.$el.addClass(source_class);
        },

        _setUpWithPath: function(path, use_short_url, filename) {
            // Set up interface for the given path. Either a url, or filepath.
            // If use_short_url is true, populate the model's `url` with the
            // filename rather than the full url (used for file uploads). Use
            // `filename` as the model name if passed.
            var name = filename || path.split('\\').pop().split('/').pop();
            var url = use_short_url ? name : path;
            this.model.set('upload', this.$('.resource_file_field')[0].files[0]);
            this.model.set('url_type', 'upload');
            this.model.set('resource_type', 'file.upload');
            this.model.set('url', url);
            if (!this.model.get('name')) {
                this.model.set('name', name);
            }
        }
    });

    var AppView = Backbone.View.extend({

        // The main app to kick things off, and manage the create widget.

        el: '#resource-app',

        events: {
            'click .add_new_resource': 'onCreateBtn'
        },

        initialize: function(options) {
            var sandbox = options.sandbox;
            this.resourceListView = undefined;

            // Listen for the hdx-contribute-global-created notification...
            sandbox.subscribe('hdx-contribute-global-created', function (global) {
                // ... when ready, get the contribute_global object.
                this.contribute_global = global;

                this.contribute_global.getDatasetIdPromise().then(
                    function(package_id){
                        var resources = new PackageResources(null, {package_id: package_id});
                        this.resources = resources;
                        this.resourceListView = new PackageResourcesListView({collection: resources});

                        this.contribute_global.setResourceModelList(this.resources);
                    }.bind(this)
                );

                global.getResourceSaveStartPromise()
                    .then(function(){
                        return this.contribute_global.getDatasetIdPromise();
                    }.bind(this))
                    .then(function(package_id){
                        return this.resources.saveAll(package_id);
                    }.bind(this))
                    .then(function(){
                        return this.resources.destroyRemovedModels();
                    }.bind(this))
                    .then(function(){
                        // debugger;
                        console.log('Browsing away ');
                        this.contribute_global.browseToDataset();
                    }.bind(this),
                    function (error){
                        console.error("error while uploading resources");
                    });
            }.bind(this));
        },

        onCreateBtn: function(e) {
            var data = {
                //id: 'new',
                /* Internally the position will start from 0 like in CKAN. In template it is +1 */
                position: this.resources.length,
                url: '',
                format: '',
                description: '',
            };
            var newResourceModel = new Resource(data);
            this.resources.add(newResourceModel);
        }
    });

    var sandbox = ckan.sandbox();
    this.app = new AppView({sandbox: sandbox});
}());
