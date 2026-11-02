
from flask import Flask, render_template

from routes.graph_routes import graph_routes
from routes.analysis_routes import analysis_routes
from routes.ai_routes import ai_routes

app = Flask(__name__)

# Register API endpoints
app.register_blueprint(graph_routes, url_prefix="/api")
app.register_blueprint(analysis_routes, url_prefix="/api")
app.register_blueprint(ai_routes, url_prefix="/api")


@app.route("/")
def index():
    return render_template("index.html")


@app.route("/health")
def health():
    return {"status": "ok"}



if __name__ == "__main__":
    app.run(
        host="127.0.0.1",
        port=5050,
        debug=True
    )
