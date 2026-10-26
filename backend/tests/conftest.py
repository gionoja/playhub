import os
import sys

# Let the tests import the backend modules (world_chat, auth, models, ...) directly.
sys.path.insert(0, os.path.dirname(os.path.dirname(os.path.abspath(__file__))))
